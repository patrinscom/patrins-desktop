const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { app } = require('electron');
const { EventEmitter } = require('events');

const API_HOST       = 'patrins.com';
const API_BASE       = 'https://' + API_HOST;
const SYNC_ROOT_NAME = 'Desktop Sync';
const STATE_FILE     = () => path.join(app.getPath('userData'), 'sync-state.json');
const TIMEOUT_MIN_MS = 60_000;          // 60 s floor for small files / API calls
const TIMEOUT_RATE   = 256 * 1024;     // assume ≥256 KB/s upload — scales for large files

class SyncEngine extends EventEmitter {
  constructor(store, getSession) {
    super();
    this.store         = store;
    this.getSession    = getSession;
    this.watcher       = null;
    this.queue         = new Map();
    this.processing    = false;
    this.paused        = false;
    this.fileState     = {};
    this.folderIds     = {};
    this.rootId        = null;
    this.lastSync      = null;
    this._currentState = 'stopped';
  }

  get localFolder() { return this.store.get('syncFolder') || null; }

  // ── Auth ───────────────────────────────────────────────────────────────────

  async _getToken() {
    try {
      const cookies = await this.getSession().cookies.get({ url: API_BASE });
      const tok = cookies.find(c => c.name === 'token');
      if (!tok) throw new Error('not logged in');
      return tok.value;
    } catch (e) {
      throw new Error('Auth failed: ' + e.message);
    }
  }

  // ── HTTP helpers (Node native https — reliable, binary-safe, timeout) ──────

  async _jsonRequest(method, urlPath, body = null) {
    const token   = await this._getToken();
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {
      Cookie: 'token=' + token,
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
    };
    const text = await this._raw(method, urlPath, headers, payload);
    return text ? JSON.parse(text) : {};
  }

  async _multipartRequest(urlPath, fileName, fileBuffer, folderId) {
    const token    = await this._getToken();
    const boundary = 'PatrinsBound' + Date.now();
    const body     = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + fileName + '"\r\nContent-Type: application/octet-stream\r\n\r\n'),
      fileBuffer,
      Buffer.from('\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="folderId"\r\n\r\n' + folderId + '\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="temporary"\r\n\r\nfalse\r\n'),
      Buffer.from('--' + boundary + '--\r\n'),
    ]);
    const headers = {
      Cookie:           'token=' + token,
      'Content-Type':   'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length,
    };
    const timeoutMs = Math.max(TIMEOUT_MIN_MS, Math.ceil(body.length / TIMEOUT_RATE) * 1000);
    const text = await this._raw('POST', urlPath, headers, body, timeoutMs);
    return JSON.parse(text);
  }

  _raw(method, urlPath, headers, body = null, timeoutMs = TIMEOUT_MIN_MS) {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: API_HOST, path: urlPath, method, headers }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400)
            reject(new Error('HTTP ' + res.statusCode + ': ' + text.slice(0, 300)));
          else
            resolve(text);
        });
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('Upload timed out after ' + Math.round(timeoutMs / 1000) + 's'));
      });

      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  // ── Convenience wrappers ───────────────────────────────────────────────────

  _get(urlPath)            { return this._jsonRequest('GET',    urlPath); }
  _post(urlPath, body)     { return this._jsonRequest('POST',   urlPath, body); }
  _delete(urlPath)         { return this._jsonRequest('DELETE', urlPath); }

  // ── Public controls ────────────────────────────────────────────────────────

  async start() {
    if (this.watcher) return;
    const folder = this.localFolder;
    if (!folder)                { this._status('no-folder'); return; }
    if (!fs.existsSync(folder)) { this._status('error', { error: 'Sync folder not found on disk' }); return; }

    this.fileState = this._loadState();
    this.folderIds = {};
    this.paused    = false;
    this._status('syncing', { file: 'Connecting…' });

    try {
      await this._ensureRootFolder();
    } catch (e) {
      this._status('error', { error: 'Cannot reach Patrins: ' + e.message });
      return;
    }

    await this._initialSync();

    const { default: chokidar } = await import('chokidar');
    this.watcher = chokidar.watch(folder, {
      ignored:          /(^|[/\\])\./,
      persistent:       true,
      ignoreInitial:    true,
      usePolling:       true,   // reliable on all Windows filesystems
      interval:         2000,   // poll every 2 s
      binaryInterval:   3000,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
    });

    this.watcher
      .on('add',       p => this._enqueue(p, 'upload'))
      .on('change',    p => this._enqueue(p, 'upload'))
      .on('unlink',    p => this._enqueue(p, 'delete'))
      .on('unlinkDir', p => this._enqueueDeleteDir(p));

    if (this._currentState !== 'error') this._status('up-to-date');
  }

  stop() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    this.queue.clear();
    this.processing = false;
    this.rootId     = null;
    this._status('stopped');
  }

  pause()  { this.paused = true;  this._status('paused'); }
  resume() { this.paused = false; this._processQueue(); }

  getStatus() {
    return {
      state:    this._currentState || (this.watcher ? 'up-to-date' : 'stopped'),
      enabled:  this.store.get('syncEnabled', false),
      folder:   this.localFolder,
      watching: !!this.watcher,
      paused:   this.paused,
      pending:  this.queue.size,
      lastSync: this.lastSync,
    };
  }

  // ── Queue ──────────────────────────────────────────────────────────────────

  _enqueue(absPath, type) {
    const rel = path.relative(this.localFolder, absPath).replace(/\\/g, '/');
    this.queue.set(rel, { type, absPath });
    this._processQueue();
  }

  _enqueueDeleteDir(absPath) {
    const relDir = path.relative(this.localFolder, absPath).replace(/\\/g, '/');
    for (const rel of Object.keys(this.fileState)) {
      if (rel.startsWith(relDir + '/'))
        this.queue.set(rel, { type: 'delete', absPath: path.join(this.localFolder, rel) });
    }
    this._processQueue();
  }

  async _processQueue() {
    if (this.processing || this.paused) return;
    this.processing = true;
    const errors = [];

    while (this.queue.size > 0 && !this.paused) {
      const [rel, op] = this.queue.entries().next().value;
      this.queue.delete(rel);
      this._status('syncing', { file: path.basename(rel), pending: this.queue.size });
      try {
        if (op.type === 'upload') await this._uploadFile(rel, op.absPath);
        else if (op.type === 'delete') await this._deleteFile(rel);
      } catch (e) {
        console.error('[Sync] Failed:', rel, e.message);
        errors.push({ rel, error: e.message });
      }
    }

    this.processing = false;
    this._saveState();

    if (!this.paused) {
      this.lastSync = Date.now();
      if (errors.length > 0) {
        const msg = errors.length === 1
          ? 'Failed: ' + path.basename(errors[0].rel) + ' — ' + errors[0].error
          : errors.length + ' files failed — ' + errors[0].error;
        this._status('error', { error: msg });
      } else {
        this._status('up-to-date');
      }
    }
  }

  // ── Initial scan ───────────────────────────────────────────────────────────

  async _initialSync() {
    const files = this._scanDir(this.localFolder);
    for (const absPath of files) {
      const rel   = path.relative(this.localFolder, absPath).replace(/\\/g, '/');
      const stat  = fs.statSync(absPath);
      const known = this.fileState[rel];
      if (!known || known.size !== stat.size || known.mtime !== stat.mtimeMs)
        this.queue.set(rel, { type: 'upload', absPath });
    }
    if (this.queue.size > 0) await this._processQueue();
  }

  _scanDir(dir) {
    const results = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...this._scanDir(full));
        else if (entry.isFile())  results.push(full);
      }
    } catch (_) {}
    return results;
  }

  // ── Server folder management ───────────────────────────────────────────────

  async _ensureRootFolder() {
    const cached = this.store.get('syncRootFolderId');
    if (cached) {
      try {
        const data = await this._get('/api/folders');
        if ((data.folders || []).find(f => f.id === cached)) {
          this.rootId = cached; return;
        }
      } catch (_) {}
      this.store.delete('syncRootFolderId');
    }

    const data     = await this._get('/api/folders');
    const existing = (data.folders || []).find(f => f.name === SYNC_ROOT_NAME && !f.parentId);
    if (existing) {
      this.rootId = existing.id;
    } else {
      const created = await this._post('/api/folders', { name: SYNC_ROOT_NAME });
      if (!created.id) throw new Error('Folder creation returned no ID');
      this.rootId = created.id;
    }
    this.store.set('syncRootFolderId', this.rootId);
  }

  async _ensureFolderPath(relDir) {
    if (!relDir || relDir === '.') return this.rootId;
    if (this.folderIds[relDir]) return this.folderIds[relDir];

    const parts  = relDir.split('/');
    let parentId = this.rootId;
    let cumPath  = '';

    for (const part of parts) {
      cumPath = cumPath ? cumPath + '/' + part : part;
      if (this.folderIds[cumPath]) { parentId = this.folderIds[cumPath]; continue; }
      try {
        const res = await this._post('/api/folders', { name: part, parentId });
        this.folderIds[cumPath] = res.id;
        parentId = res.id;
      } catch (_) {
        const data  = await this._get('/api/folders?parentId=' + parentId);
        const found = (data.folders || []).find(f => f.name === part);
        if (found) { this.folderIds[cumPath] = found.id; parentId = found.id; }
        else throw new Error('Cannot find or create subfolder: ' + part);
      }
    }
    return parentId;
  }

  // ── File operations ────────────────────────────────────────────────────────

  async _uploadFile(rel, absPath) {
    if (!fs.existsSync(absPath)) return;
    const stat = fs.statSync(absPath);

    const known = this.fileState[rel];
    if (known?.id) await this._delete('/api/files/' + known.id).catch(() => {});

    const relDir   = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : null;
    const folderId = await this._ensureFolderPath(relDir);
    const fileName = path.basename(rel);
    const fileBuf  = fs.readFileSync(absPath);

    const res    = await this._multipartRequest('/api/upload', fileName, fileBuf, folderId);
    const fileId = res.file?.id || res.id;
    if (!fileId) throw new Error('Upload returned no file ID');
    this.fileState[rel] = { id: fileId, mtime: stat.mtimeMs, size: stat.size };
  }

  async _deleteFile(rel) {
    const known = this.fileState[rel];
    if (known?.id) await this._delete('/api/files/' + known.id).catch(() => {});
    delete this.fileState[rel];
  }

  // ── State persistence ──────────────────────────────────────────────────────

  _loadState()  {
    try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return {}; }
  }

  _saveState() {
    try { fs.writeFileSync(STATE_FILE(), JSON.stringify(this.fileState)); } catch (_) {}
  }

  _status(state, extra = {}) {
    this._currentState = state;
    this.emit('status', { state, pending: this.queue.size, lastSync: this.lastSync, folder: this.localFolder, ...extra });
  }
}

module.exports = SyncEngine;
