const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

const API_HOST       = 'patrins.com';
const MAX_QUEUE      = 100;
const FLUSH_INTERVAL = 5 * 60 * 1000; // 5 min

let _store    = null;
let _ver      = '0.0.0';
let _deviceId = null;
let _queue    = [];
let _timer    = null;
let _enabled  = false; // stays false until init() confirms packaged + opted-in

function _pendingFile() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'pending-logs.json');
}

function init(store, version) {
  const { app } = require('electron');
  if (!app.isPackaged) return; // never run in dev

  _store   = store;
  _ver     = version;
  _enabled = store.get('diagnosticsEnabled', true);
  if (!_enabled) return;

  _deviceId = store.get('deviceId');
  if (!_deviceId) {
    _deviceId = crypto.randomUUID();
    store.set('deviceId', _deviceId);
  }

  // Load events unsent from last session
  try {
    const saved = JSON.parse(fs.readFileSync(_pendingFile(), 'utf8'));
    if (Array.isArray(saved)) _queue = saved.slice(0, MAX_QUEUE);
  } catch (_) {}

  _timer = setInterval(flush, FLUSH_INTERVAL);
}

function setEnabled(val) {
  _enabled = !!val;
  if (_store) _store.set('diagnosticsEnabled', _enabled);
  if (!_enabled) { _queue = []; _savePending(); }
}

function isEnabled() { return _enabled; }

function log(event, data) {
  if (!_enabled || !_deviceId) return;
  const entry = { v: _ver, d: _deviceId, ts: Date.now(), e: event };
  if (data && typeof data === 'object' && Object.keys(data).length) {
    entry.x = _sanitize(data);
  }
  _queue.push(entry);
  if (_queue.length > MAX_QUEUE) _queue = _queue.slice(-MAX_QUEUE);
  _savePending();
}

// Strip paths and personal data; only allow short primitives
function _sanitize(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      out[k] = v
        .replace(/[A-Za-z]:[\\\/][^\s,;|<>]*/g, '<path>')
        .replace(/(?:\/[a-zA-Z0-9_.~%-]+){2,}/g, '<path>')
        .slice(0, 200);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

// Bucket raw byte counts into non-identifying size ranges
function sizeRange(bytes) {
  if (!bytes || bytes <= 0)                return 'empty';
  if (bytes < 1024 * 1024)                return '<1MB';
  if (bytes < 5   * 1024 * 1024)          return '1-5MB';
  if (bytes < 50  * 1024 * 1024)          return '5-50MB';
  if (bytes < 500 * 1024 * 1024)          return '50-500MB';
  if (bytes < 5   * 1024 * 1024 * 1024)  return '500MB-5GB';
  return '>5GB';
}

function _savePending() {
  try { fs.writeFileSync(_pendingFile(), JSON.stringify(_queue)); } catch (_) {}
}

async function flush() {
  if (!_enabled || _queue.length === 0) return;
  const batch = _queue.splice(0);
  _savePending();
  try {
    await _post('/api/desktop/logs', batch);
  } catch (_) {
    _queue = [...batch, ..._queue].slice(-MAX_QUEUE);
    _savePending();
  }
}

function _post(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: API_HOST,
      path:     urlPath,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': payload.length,
        'X-App-Version':  _ver,
      },
    }, (res) => {
      res.resume();
      res.statusCode < 400 ? resolve() : reject(new Error('HTTP ' + res.statusCode));
    });
    req.setTimeout(10000, () => req.destroy());
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function shutdown() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  await flush();
}

module.exports = { init, log, sizeRange, setEnabled, isEnabled, flush, shutdown };
