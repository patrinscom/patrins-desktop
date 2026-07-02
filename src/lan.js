/**
 * LAN Peer-to-Peer transfer module
 *
 * Discovery: UDP broadcast on port 34872 — peers announce themselves every 5s
 * Transfer:  Local HTTP server on a random port — direct file upload via multipart POST
 *
 * No external dependencies — uses Node built-ins only.
 */
const dgram  = require('dgram');
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const DISCOVERY_PORT = 34872;
const BEACON_INTERVAL_MS = 5000;
const PEER_TTL_MS = 15000; // remove peer if no beacon for 15s

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address !== '127.0.0.1') {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

class LanEngine extends EventEmitter {
  constructor(store) {
    super();
    this.store       = store;
    this.localIP     = getLocalIP();
    this.peerId      = store.get('lanPeerId') || (() => {
      const id = crypto.randomBytes(8).toString('hex');
      store.set('lanPeerId', id);
      return id;
    })();
    this._udp        = null;
    this._httpServer = null;
    this._httpPort   = null;
    this._beaconTimer = null;
    this._peers      = new Map(); // peerId → { username, ip, port, seenAt }
    this._pruneTimer  = null;
    this._saveDir     = null; // where received files land
    this._username    = 'Unknown';
    this._running     = false;
    this._receiveToken = null; // one-time auth token for incoming transfers
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  async start(username, saveDir) {
    if (this._running) return;
    this._username = username || os.userInfo().username || 'Patrins User';
    this._saveDir  = saveDir || app?.getPath('downloads') || os.tmpdir();
    this._receiveToken = crypto.randomBytes(16).toString('hex');

    await this._startHttpServer();
    await this._startUDP();

    this._running = true;
    this._beaconTimer = setInterval(() => this._sendBeacon(), BEACON_INTERVAL_MS);
    this._pruneTimer  = setInterval(() => this._prunePeers(), 5000);
    this._sendBeacon(); // announce immediately
    this.emit('started', { ip: this.localIP, port: this._httpPort });
    console.log('[LAN] Started — listening on', this.localIP + ':' + this._httpPort);
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    clearInterval(this._beaconTimer);
    clearInterval(this._pruneTimer);
    this._udp?.close();
    this._udp = null;
    this._httpServer?.close();
    this._httpServer = null;
    this._peers.clear();
    this.emit('stopped');
    console.log('[LAN] Stopped');
  }

  getPeers() {
    const now = Date.now();
    return [...this._peers.values()].filter(p => now - p.seenAt < PEER_TTL_MS);
  }

  // Send a file to a peer — resolves with { ok, error? }
  async sendFile(peerId, absPath) {
    const peer = this._peers.get(peerId);
    if (!peer) return { ok: false, error: 'Peer not found' };
    if (!fs.existsSync(absPath)) return { ok: false, error: 'File not found' };

    const fileName = path.basename(absPath);
    const fileSize = fs.statSync(absPath).size;
    const boundary = 'patrins' + crypto.randomBytes(8).toString('hex');

    return new Promise((resolve) => {
      const headerPart = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
      );
      const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`);
      const totalSize  = headerPart.length + fileSize + footerPart.length;

      const req = http.request({
        host:    peer.ip,
        port:    peer.port,
        path:    '/receive',
        method:  'POST',
        headers: {
          'Content-Type':   `multipart/form-data; boundary=${boundary}`,
          'Content-Length': totalSize,
          'X-LAN-Token':    peer.receiveToken,
          'X-Sender-Name':  this._username,
        },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end',  ()  => {
          try {
            const j = JSON.parse(body);
            resolve({ ok: j.ok, error: j.error });
          } catch {
            resolve({ ok: res.statusCode < 300, error: res.statusCode >= 300 ? body : undefined });
          }
        });
      });

      req.on('error', (err) => resolve({ ok: false, error: err.message }));

      req.write(headerPart);
      const stream = fs.createReadStream(absPath);
      let sent = 0;
      stream.on('data', (chunk) => {
        req.write(chunk);
        sent += chunk.length;
        this.emit('send-progress', { peerId, file: fileName, pct: Math.round((sent / fileSize) * 100) });
      });
      stream.on('end',   () => { req.write(footerPart); req.end(); });
      stream.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _startHttpServer() {
    return new Promise((resolve, reject) => {
      this._httpServer = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/receive') {
          this._handleReceive(req, res);
        } else {
          res.writeHead(404); res.end('Not found');
        }
      });
      this._httpServer.listen(0, '0.0.0.0', () => {
        this._httpPort = this._httpServer.address().port;
        resolve();
      });
      this._httpServer.on('error', reject);
    });
  }

  _startUDP() {
    return new Promise((resolve, reject) => {
      this._udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this._udp.bind(DISCOVERY_PORT, () => {
        try {
          this._udp.setBroadcast(true);
          this._udp.setMulticastLoopback(false);
        } catch (_) {}
        resolve();
      });
      this._udp.on('error', (err) => { console.error('[LAN] UDP error:', err.message); });
      this._udp.on('message', (msg, rinfo) => this._onBeacon(msg, rinfo));
      this._udp.on('error', reject);
    });
  }

  _sendBeacon() {
    if (!this._udp || !this._running) return;
    const beacon = JSON.stringify({
      v: 1,
      id: this.peerId,
      name: this._username,
      ip: this.localIP,
      port: this._httpPort,
      token: this._receiveToken,
    });
    const buf = Buffer.from(beacon);
    this._udp.send(buf, 0, buf.length, DISCOVERY_PORT, '255.255.255.255', () => {});
  }

  _onBeacon(msg, rinfo) {
    try {
      const data = JSON.parse(msg.toString());
      if (!data.id || data.id === this.peerId) return; // ignore self
      if (data.v !== 1) return;

      const isNew = !this._peers.has(data.id);
      this._peers.set(data.id, {
        id:           data.id,
        username:     data.name || rinfo.address,
        ip:           data.ip || rinfo.address,
        port:         data.port,
        receiveToken: data.token,
        seenAt:       Date.now(),
      });
      if (isNew) {
        console.log('[LAN] Peer discovered:', data.name, rinfo.address);
        this.emit('peer-found', this.getPeers());
      }
    } catch (_) {}
  }

  _prunePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this._peers) {
      if (now - peer.seenAt > PEER_TTL_MS) {
        this._peers.delete(id);
        changed = true;
        console.log('[LAN] Peer lost:', peer.username);
      }
    }
    if (changed) this.emit('peers-changed', this.getPeers());
  }

  _handleReceive(req, res) {
    const token = req.headers['x-lan-token'];
    if (token !== this._receiveToken) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid token' }));
      return;
    }

    const sender   = req.headers['x-sender-name'] || 'Unknown';
    const rawCT    = req.headers['content-type'] || '';
    const boundary = (rawCT.match(/boundary=(\S+)/) || [])[1];
    if (!boundary) {
      res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'No boundary' }));
      return;
    }

    // Extract filename from Content-Disposition header in the multipart body
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headerEnd = body.indexOf('\r\n\r\n');
      if (headerEnd < 0) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Bad body' })); return; }

      const headerText = body.slice(0, headerEnd).toString();
      const filenameMatch = headerText.match(/filename="([^"]+)"/);
      const fileName = filenameMatch ? path.basename(filenameMatch[1]) : 'received-file';

      // File data: after header, strip trailing boundary
      const fileStart = headerEnd + 4;
      const footerStr = `\r\n--${boundary}--`;
      const footerBuf = Buffer.from(footerStr);
      let fileEnd = body.length - footerBuf.length;
      if (body.slice(fileEnd).equals(footerBuf)) {
        // correct
      } else {
        fileEnd = body.length;
      }
      const fileData = body.slice(fileStart, fileEnd);

      const savePath = path.join(this._saveDir, fileName);
      fs.writeFile(savePath, fileData, (err) => {
        if (err) {
          res.writeHead(500); res.end(JSON.stringify({ ok: false, error: err.message }));
          return;
        }
        console.log('[LAN] Received from', sender, '→', savePath);
        this.emit('file-received', { from: sender, fileName, savePath, size: fileData.length });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
  }
}

module.exports = LanEngine;
