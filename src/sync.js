const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { app } = require('electron');
const { EventEmitter } = require('events');
const tus     = require('tus-js-client');
const logger  = require('./logger');

const API_HOST       = 'patrins.com';
const API_BASE       = 'https://' + API_HOST;
const SYNC_ROOT_NAME = 'Desktop Sync';
const STATE_FILE     = (id) => path.join(app.getPath('userData'), id ? `sync-state-${id}.json` : 'sync-state.json');
const TUS_URLS_FILE  = (id) => path.join(app.getPath('userData'), id ? `tus-urls-${id}.json`   : 'tus-resume-urls.json');
const TIMEOUT_MIN_MS = 60_000;
const TIMEOUT_RATE   = 256 * 1024;
const MAX_SYNC_SIZE  = 50 * 1024 * 1024 * 1024; // 50 GB hard cap per file

// Persistent tus upload URL store — survives process restarts for true resume
class FileUrlStorage {
  constructor(instanceId = null) { this._id = instanceId; }
  _read() {
    try { return JSON.parse(fs.readFileSync(TUS_URLS_FILE(this._id), 'utf8')); } catch { return {}; }
  }
  _write(data) {
    try { fs.writeFileSync(TUS_URLS_FILE(this._id), JSON.stringify(data)); } catch (_) {}
  }
  async findAllUploads() { return Object.values(this._read()); }
  async findUploadsByFingerprint(fp) {
    const d = this._read();
    return d[fp] ? [{ ...d[fp], urlStorageKey: fp }] : [];
  }
  async removeUpload(key) {
    const d = this._read(); delete d[key]; this._write(d);
  }
  async addUpload(fp, upload) {
    const d = this._read(); d[fp] = upload; this._write(d); return fp;
  }
}

class SyncEngine extends EventEmitter {
  /**
   * @param {object} store          electron-store instance
   * @param {function} getSession   returns the Electron session
   * @param {string|null} folderOverride  if set, overrides the store syncFolder (for watch folders)
   * @param {string|null} instanceId      unique ID for this engine (used to namespace state files)
   */
  constructor(store, getSession, folderOverride = null, instanceId = null) {
    super();
    this.store           = store;
    this.getSession      = getSession;
    this._folderOverride = folderOverride;
    this._instanceId     = instanceId;
    this.watcher         = null;
    this.queue           = new Map();
    this.processing      = false;
    this.paused          = false;
    this.fileState       = {};
    this.folderIds       = {};
    this.rootId          = null;
    this.lastSync        = null;
    this._currentState   = 'stopped';
  }

  get localFolder() {
    return this._folderOverride || this.store.get('syncFolder') || null;
  }

  get _syncRootName() {
    if (!this._folderOverride) return SYNC_ROOT_NAME;
    return 'Watch: ' + path.basename(this._folderOverride);
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  async _getToken() {
    const session = typeof this.getSession === 'function' ? this.getSession() : this.getSession;
    if (!session) throw new Error('No session available');
    try {
      const cookies = await session.cookies.get({ url: API_BASE });
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

  async _tusUpload(absPath, fileName, folderId, fileSize) {
    const token = await this._getToken();

    return new Promise((resolve, reject) => {
      let resolvedFileId = null;

      const upload = new tus.Upload(fs.createReadStream(absPath), {
        endpoint:   'https://patrins.com/api/tus/',
        uploadSize: fileSize,
        chunkSize:  15 * 1024 * 1024,
        retryDelays: [0, 3000, 5000, 10000, 20000],
        storePreviousUploads: true,
        urlStorage: new FileUrlStorage(this._instanceId),
        headers: { Cookie: 'token=' + token },
        metadata: {
          filename:  fileName,
          filetype:  'application/octet-stream',
          folderId:  folderId || '',
          isTemp:    'false',
        },
        onAfterResponse: (_req, res) => {
          const id = res.getHeader('X-File-Id');
          if (id) resolvedFileId = id;
        },
        onError: (err) => {
          logger.log('tus_upload_error', { error: err?.message, size: logger.sizeRange(fileSize) });
          reject(err);
        },
        onSuccess: () => resolve(resolvedFileId),
      });

      upload.findPreviousUploads().then((prev) => {
        if (prev.length > 0) upload.resumeFromPreviousUpload(prev[0]);
        upload.start();
      }).catch(() => upload.start());
    });
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
      logger.log('sync_connect_error', { error: e.message });
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
        logger.log('sync_upload_error', {
          error: e.message,
          ext:   (path.extname(rel) || '').toLowerCase().slice(1, 10) || 'none',
          op:    op.type,
        });
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
    const cacheKey = this._instanceId ? `syncRootFolderId_${this._instanceId}` : 'syncRootFolderId';
    const cached = this.store.get(cacheKey);
    if (cached) {
      try {
        const data = await this._get('/api/folders');
        if ((data.folders || []).find(f => f.id === cached)) {
          this.rootId = cached; return;
        }
      } catch (_) {}
      this.store.delete(cacheKey);
    }

    const rootName = this._syncRootName;
    const data     = await this._get('/api/folders');
    const existing = (data.folders || []).find(f => f.name === rootName && !f.parentId);
    if (existing) {
      this.rootId = existing.id;
    } else {
      const created = await this._post('/api/folders', { name: rootName });
      if (!created.id) throw new Error('Folder creation returned no ID');
      this.rootId = created.id;
    }
    this.store.set(cacheKey, this.rootId);
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

    if (stat.size > MAX_SYNC_SIZE) {
      throw new Error(`File too large to sync (${(stat.size / 1e9).toFixed(1)} GB). Max 50 GB.`);
    }

    const known = this.fileState[rel];
    if (known?.id) await this._delete('/api/files/' + known.id).catch(() => {});

    const relDir   = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : null;
    const folderId = await this._ensureFolderPath(relDir);
    const fileName = path.basename(rel);

    const fileId = await this._tusUpload(absPath, fileName, folderId, stat.size);
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
    try { return JSON.parse(fs.readFileSync(STATE_FILE(this._instanceId), 'utf8')); } catch { return {}; }
  }

  _saveState() {
    try { fs.writeFileSync(STATE_FILE(this._instanceId), JSON.stringify(this.fileState)); } catch (_) {}
  }

  _status(state, extra = {}) {
    this._currentState = state;
    this.emit('status', { state, pending: this.queue.size, lastSync: this.lastSync, folder: this.localFolder, ...extra });
  }
}

module.exports = SyncEngine;
