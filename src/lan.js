/**
 * Patrins LAN P2P Transfer Engine
 *
 * ── Discovery ────────────────────────────────────────────────────────────────
 *   UDP broadcast on port 34872, beacon JSON every 5 s:
 *   { v:1, id, name, ip, port, platform:'desktop'|'android' }
 *
 * ── HTTP Transfer API (on a random OS-assigned port) ─────────────────────────
 *   GET  /info
 *     Response: { name, platform:'desktop', version:'1', id }
 *
 *   POST /request                           ← Android / other desktop asks to send
 *     Body JSON: { fileName, fileSize, senderName, senderId }
 *     Response (long-poll, up to 30 s):
 *       { ok:true,  token:'<one-time-token>' }  if user accepts
 *       { ok:false, reason:'denied'|'timeout' }  if user denies / times out
 *
 *   POST /receive                           ← actual file bytes
 *     Headers:
 *       X-LAN-Token   : <one-time token from /request>
 *       X-File-Name   : <URL-encoded filename>
 *       X-File-Size   : <bytes>
 *       X-Sender-Name : <display name>
 *       Content-Type  : application/octet-stream
 *       Content-Length: <bytes>
 *     Body: raw file bytes (streamed directly to disk)
 *     Response: { ok:true, fileName, size } | { ok:false, error }
 *
 * ── Events emitted ────────────────────────────────────────────────────────────
 *   started          ({ ip, port })
 *   stopped          ()
 *   peer-found       (peers[])
 *   peers-changed    (peers[])
 *   incoming-request ({ requestId, senderName, senderId, fileName, fileSize })
 *   receive-progress ({ requestId, fileName, received, total, pct, speedBps })
 *   file-received    ({ from, fileName, savePath, size })
 *   send-progress    ({ peerId, fileName, sent, total, pct, speedBps })
 *   send-done        ({ peerId, fileName, ok, error? })
 *
 * ── Android integration ───────────────────────────────────────────────────────
 *   1. Capture UDP beacons on port 34872
 *   2. POST /request to the desktop's HTTP server → get a one-time token
 *   3. Stream file via POST /receive with token + X-File-* headers
 *   No external dependencies — Node built-ins only.
 */
const dgram  = require('dgram');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DISCOVERY_PORT     = 34872; // UDP — both send/receive on this port
const BEACON_INTERVAL_MS = 5_000;
const PEER_TTL_MS        = 15_000; // drop peer after 15 s without a beacon
const REQUEST_TIMEOUT_MS = 30_000; // user has 30 s to accept/deny
const VERSION            = '1';

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function uniqueSavePath(dir, name) {
  const ext  = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${n++})${ext}`);
  }
  return candidate;
}

function fmtBytes(n) {
  if (n < 1024)        return n + ' B';
  if (n < 1048576)     return (n / 1024).toFixed(1)   + ' KB';
  if (n < 1073741824)  return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

// ─────────────────────────────────────────────────────────────────────────────

class LanEngine extends EventEmitter {
  constructor(store) {
    super();
    this.store    = store;
    this.localIP  = getLocalIP();
    this.peerId   = store.get('lanPeerId') || (() => {
      const id = crypto.randomBytes(8).toString('hex');
      store.set('lanPeerId', id);
      return id;
    })();

    this._udp            = null;
    this._httpServer     = null;
    this._httpPort       = null;
    this._beaconTimer    = null;
    this._pruneTimer     = null;
    this._peers          = new Map();   // peerId → PeerInfo
    this._pendingReqs    = new Map();   // requestId → { resolve, timer, meta }
    this._validTokens    = new Map();   // oneTimeToken → expiry timestamp
    this._saveDir        = null;
    this._username       = 'Desktop';
    this._running        = false;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async start(username, saveDir) {
    if (this._running) return { ip: this.localIP, port: this._httpPort };
    this.localIP   = getLocalIP();                      // re-read in case interface changed
    this._username = username || os.userInfo().username || 'Desktop';
    this._saveDir  = saveDir  || os.homedir();

    await this._startHttpServer();
    await this._startUDP();

    this._running      = true;
    this._beaconTimer  = setInterval(() => this._sendBeacon(), BEACON_INTERVAL_MS);
    this._pruneTimer   = setInterval(() => this._prunePeers(),  5_000);
    this._sendBeacon();

    console.log(`[LAN] Started — ${this.localIP}:${this._httpPort} (id=${this.peerId})`);
    this.emit('started', { ip: this.localIP, port: this._httpPort });
    return { ip: this.localIP, port: this._httpPort };
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    clearInterval(this._beaconTimer);
    clearInterval(this._pruneTimer);
    // Deny all pending requests
    for (const [id, req] of this._pendingReqs) {
      clearTimeout(req.timer);
      req.resolve({ ok: false, reason: 'server stopping' });
    }
    this._pendingReqs.clear();
    this._validTokens.clear();
    try { this._udp?.close(); }       catch (_) {}
    try { this._httpServer?.close(); } catch (_) {}
    this._udp = null;
    this._httpServer = null;
    this._peers.clear();
    this.emit('stopped');
    console.log('[LAN] Stopped');
  }

  getPeers() {
    const now = Date.now();
    return [...this._peers.values()].filter(p => now - p.seenAt < PEER_TTL_MS);
  }

  /** Called by main process when user accepts/denies an incoming-request */
  respondToRequest(requestId, accepted) {
    const pending = this._pendingReqs.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pendingReqs.delete(requestId);

    if (accepted) {
      const token   = crypto.randomBytes(24).toString('hex');
      const expires = Date.now() + 5 * 60 * 1000; // token valid for 5 min
      this._validTokens.set(token, expires);
      pending.resolve({ ok: true, token });
      console.log(`[LAN] Request ${requestId} accepted — token issued`);
    } else {
      pending.resolve({ ok: false, reason: 'denied' });
      console.log(`[LAN] Request ${requestId} denied`);
    }
  }

  /** Send a file to a peer — resolves once the full transfer is complete */
  async sendFile(peerId, absPath) {
    const peer = this._peers.get(peerId);
    if (!peer)               return { ok: false, error: 'Peer not found or offline' };
    if (!fs.existsSync(absPath)) return { ok: false, error: 'File not found: ' + absPath };

    const fileName = path.basename(absPath);
    const fileSize = fs.statSync(absPath).size;

    console.log(`[LAN] Sending "${fileName}" (${fmtBytes(fileSize)}) to ${peer.username} @ ${peer.ip}:${peer.port}`);

    // ── Step 1: request permission ────────────────────────────────────────────
    let token;
    try {
      const reqResult = await this._httpPost(peer, '/request', {
        fileName,
        fileSize,
        senderName: this._username,
        senderId:   this.peerId,
      }, REQUEST_TIMEOUT_MS + 5_000); // extra buffer beyond the server's timeout

      if (!reqResult.ok) {
        return { ok: false, error: 'Transfer denied by recipient: ' + (reqResult.reason || 'denied') };
      }
      token = reqResult.token;
    } catch (e) {
      return { ok: false, error: 'Could not reach peer: ' + e.message };
    }

    // ── Step 2: stream the file ────────────────────────────────────────────────
    return new Promise((resolve) => {
      const req = http.request({
        host:    peer.ip,
        port:    peer.port,
        path:    '/receive',
        method:  'POST',
        timeout: 0, // no timeout — large files take a long time
        headers: {
          'Content-Type':   'application/octet-stream',
          'Content-Length': fileSize,
          'X-LAN-Token':    token,
          'X-Sender-Name':  this._username,
          'X-File-Name':    encodeURIComponent(fileName),
          'X-File-Size':    String(fileSize),
        },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve({ ok: j.ok, error: j.error });
          } catch {
            resolve({ ok: res.statusCode < 300 });
          }
          this.emit('send-done', { peerId, fileName, ok: res.statusCode < 300 });
        });
      });

      req.on('error', (err) => {
        resolve({ ok: false, error: err.message });
        this.emit('send-done', { peerId, fileName, ok: false, error: err.message });
      });

      // Pipe file → request with progress tracking
      let sent    = 0;
      let lastTs  = Date.now();
      let lastSent = 0;

      const stream = fs.createReadStream(absPath, { highWaterMark: 256 * 1024 }); // 256 KB chunks
      stream.on('data', (chunk) => {
        sent += chunk.length;
        const now     = Date.now();
        const elapsed = (now - lastTs) / 1000;
        if (elapsed >= 0.5 || sent === fileSize) {
          const speedBps = (sent - lastSent) / Math.max(elapsed, 0.001);
          const pct      = fileSize ? Math.round((sent / fileSize) * 100) : 100;
          lastTs   = now;
          lastSent = sent;
          this.emit('send-progress', { peerId, fileName, sent, total: fileSize, pct, speedBps });
        }
      });
      stream.on('error', (err) => resolve({ ok: false, error: err.message }));
      stream.pipe(req);
    });
  }

  // ── Private: HTTP server ────────────────────────────────────────────────────

  _startHttpServer() {
    return new Promise((resolve, reject) => {
      this._httpServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LAN-Token, X-File-Name, X-File-Size, X-Sender-Name, X-Request-Id');
        // Browser sends OPTIONS preflight for cross-origin requests with custom headers
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        if (req.method === 'GET'  && req.url === '/info')    this._handleInfo(req, res);
        else if (req.method === 'POST' && req.url === '/request') this._handleRequest(req, res);
        else if (req.method === 'POST' && req.url === '/receive') this._handleReceive(req, res);
        else { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); }
      });
      // Port 0 = OS picks an available port
      this._httpServer.listen(0, '0.0.0.0', () => {
        this._httpPort = this._httpServer.address().port;
        resolve();
      });
      this._httpServer.on('error', reject);
    });
  }

  _handleInfo(_req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name:     this._username,
      platform: 'desktop',
      version:  VERSION,
      id:       this.peerId,
    }));
  }

  _handleRequest(req, res) {
    this._readJSON(req).then(async (body) => {
      const { fileName, fileSize, senderName, senderId } = body || {};
      if (!fileName || !fileSize || !senderName) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Missing fields' }));
        return;
      }

      const requestId = crypto.randomBytes(8).toString('hex');
      console.log(`[LAN] Incoming request ${requestId}: "${fileName}" (${fmtBytes(fileSize)}) from ${senderName}`);

      // Emit to main process — it will call respondToRequest() after showing a dialog
      this.emit('incoming-request', { requestId, senderName, senderId, fileName, fileSize });

      // Long-poll: wait for main process to call respondToRequest
      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this._pendingReqs.delete(requestId);
          resolve({ ok: false, reason: 'timeout' });
        }, REQUEST_TIMEOUT_MS);

        this._pendingReqs.set(requestId, { resolve, timer, meta: { fileName, fileSize, senderName } });
      });

      if (res.socket?.destroyed) return; // client disconnected while we waited

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    }).catch((e) => {
      res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message }));
    });
  }

  _handleReceive(req, res) {
    const token = req.headers['x-lan-token'];

    // Validate token — must be a currently-valid one-time token
    const expiry = this._validTokens.get(token);
    if (!expiry || Date.now() > expiry) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid or expired token' }));
      console.warn('[LAN] Rejected /receive — bad token');
      return;
    }
    this._validTokens.delete(token); // consume one-time token immediately

    const rawName   = req.headers['x-file-name']   || 'received-file';
    const fileSize  = parseInt(req.headers['x-file-size'] || '0', 10);
    const sender    = req.headers['x-sender-name']  || 'Unknown';
    const requestId = req.headers['x-request-id']   || '';

    // Sanitise filename: no path traversal, printable chars only
    const safeBase  = path.basename(decodeURIComponent(rawName)).replace(/[^\w\s.\-()[\]]/g, '_') || 'file';
    const savePath  = uniqueSavePath(this._saveDir, safeBase);
    const tmpPath   = savePath + '.part';

    console.log(`[LAN] Receiving "${safeBase}" (${fmtBytes(fileSize)}) from ${sender}`);

    const ws = fs.createWriteStream(tmpPath);
    let received = 0;
    let lastTs   = Date.now();
    let lastRecv = 0;

    req.on('data', (chunk) => {
      received += chunk.length;
      ws.write(chunk);

      const now     = Date.now();
      const elapsed = (now - lastTs) / 1000;
      if (elapsed >= 0.5 || received === fileSize) {
        const speedBps = (received - lastRecv) / Math.max(elapsed, 0.001);
        const pct      = fileSize ? Math.round((received / fileSize) * 100) : 0;
        lastTs   = now;
        lastRecv = received;
        this.emit('receive-progress', { requestId, fileName: safeBase, received, total: fileSize, pct, speedBps });
      }
    });

    req.on('end', () => {
      ws.end(() => {
        // Move .part → final path
        fs.rename(tmpPath, savePath, (err) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
            fs.unlink(tmpPath, () => {});
            return;
          }
          console.log(`[LAN] Saved: ${savePath} (${fmtBytes(received)})`);
          this.emit('file-received', { from: sender, fileName: safeBase, savePath, size: received });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, fileName: safeBase, size: received }));
        });
      });
    });

    req.on('error', (err) => {
      ws.destroy();
      fs.unlink(tmpPath, () => {});
      console.error('[LAN] Receive error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
  }

  // ── Private: UDP discovery ──────────────────────────────────────────────────

  _startUDP() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.bind(DISCOVERY_PORT, '0.0.0.0', () => {
        try { sock.setBroadcast(true); } catch (_) {}
        this._udp = sock;
        resolve();
      });
      sock.on('message', (msg, rinfo) => this._onBeacon(msg, rinfo));
      sock.on('error',   (err) => console.error('[LAN] UDP error:', err.message));
      sock.once('error', reject); // reject on bind failure
    });
  }

  _sendBeacon() {
    if (!this._udp || !this._running) return;
    const beacon = Buffer.from(JSON.stringify({
      v:        1,
      id:       this.peerId,
      name:     this._username,
      ip:       this.localIP,
      port:     this._httpPort,
      platform: 'desktop',
    }));
    this._udp.send(beacon, 0, beacon.length, DISCOVERY_PORT, '255.255.255.255', () => {});
  }

  _onBeacon(msg, rinfo) {
    try {
      const data = JSON.parse(msg.toString());
      if (data.v !== 1 || !data.id || data.id === this.peerId) return;

      const isNew = !this._peers.has(data.id);
      this._peers.set(data.id, {
        id:       data.id,
        username: data.name    || rinfo.address,
        ip:       data.ip      || rinfo.address,
        port:     data.port,
        platform: data.platform || 'unknown',
        seenAt:   Date.now(),
      });

      if (isNew) {
        console.log(`[LAN] Peer found: ${data.name} (${data.platform}) @ ${rinfo.address}`);
        this.emit('peer-found', this.getPeers());
      }
    } catch (_) {}
  }

  _prunePeers() {
    const now     = Date.now();
    let   changed = false;
    for (const [id, peer] of this._peers) {
      if (now - peer.seenAt > PEER_TTL_MS) {
        this._peers.delete(id);
        changed = true;
        console.log(`[LAN] Peer lost: ${peer.username}`);
      }
    }
    if (changed) this.emit('peers-changed', this.getPeers());
  }

  // ── Private: helpers ────────────────────────────────────────────────────────

  _readJSON(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; if (body.length > 4096) reject(new Error('Body too large')); });
      req.on('end',  ()  => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }

  _httpPost(peer, urlPath, bodyObj, timeoutMs = 35_000) {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(bodyObj));
      const req = http.request({
        host:    peer.ip,
        port:    peer.port,
        path:    urlPath,
        method:  'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': payload.length,
        },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end',  ()  => {
          try { resolve(JSON.parse(body)); }
          catch { resolve({ ok: false, error: 'Bad JSON response' }); }
        });
      });
      req.on('error',   reject);
      req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
      req.write(payload);
      req.end();
    });
  }
}

module.exports = LanEngine;
