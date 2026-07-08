const { BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');

let lanWin    = null;
let _lan      = null;
let _startLan = null;

// Local Transfer now runs entirely in a web page served from patrins.com. The window
// loads it over HTTPS in the shared session (so it's authenticated by the same login
// cookie as the main window) and connects to the phone over WebRTC — no local HTTP
// server needed, which also avoids a Windows Firewall prompt. `startLan` is accepted
// for backward compatibility but intentionally NOT invoked.
function showLanWindow(/* startLan */) {
  if (lanWin && !lanWin.isDestroyed()) {
    if (!lanWin.isVisible()) lanWin.show();
    lanWin.focus();
    return;
  }

  const { workAreaSize, workArea } = screen.getPrimaryDisplay();
  const W = 460, H = 680;
  const x = (workArea.x || 0) + workAreaSize.width  - W - 40;
  const y = Math.max((workArea.y || 0) + 40, (workArea.y || 0) + workAreaSize.height - H - 60);

  lanWin = new BrowserWindow({
    width: W, height: H, x, y,
    minWidth: 380, minHeight: 520,
    title: 'Patrins — Local Transfer',
    backgroundColor: '#111110',
    frame: true,
    autoHideMenuBar: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  lanWin.loadURL('https://patrins.com/local-transfer?host=1');
  lanWin.on('closed', () => { lanWin = null; });
}

function hideLanWindow() {
  if (lanWin && !lanWin.isDestroyed()) lanWin.hide();
}

function getLanWindow() { return lanWin; }

function pushPeers(peers) {
  if (lanWin && !lanWin.isDestroyed() && lanWin.isVisible()) {
    lanWin.webContents.send('lan-win:peers', peers);
  }
}

function pushSendProgress(data) {
  if (lanWin && !lanWin.isDestroyed()) {
    lanWin.webContents.send('lan-win:send-progress', data);
  }
}

function pushSendDone(data) {
  if (lanWin && !lanWin.isDestroyed()) {
    lanWin.webContents.send('lan-win:send-done', data);
  }
}

function pushIncoming(data) {
  if (lanWin && !lanWin.isDestroyed()) {
    lanWin.webContents.send('lan-win:incoming', data);
  }
}

function pushReceiveProgress(data) {
  if (lanWin && !lanWin.isDestroyed()) {
    lanWin.webContents.send('lan-win:receive-progress', data);
  }
}

function pushFileReceived(data) {
  if (lanWin && !lanWin.isDestroyed()) {
    lanWin.webContents.send('lan-win:file-received', data);
  }
}

function initLanWindowIPC(lan, getSession, startLan) {
  _lan      = lan;
  _startLan = startLan || null;

  ipcMain.handle('lan-win:peers', () => _lan ? _lan.getPeers() : []);

  ipcMain.handle('lan-win:status', () => ({
    running: _lan?._running || false,
    ip:      _lan?.localIP  || null,
    port:    _lan?._httpPort || null,
  }));

  ipcMain.handle('lan-win:announce', async () => {
    // Auto-start LAN engine if not already running
    if (!_lan?._running) {
      if (_startLan) {
        try { await _startLan(); } catch (e) {
          return { ok: false, error: 'Failed to start: ' + e.message };
        }
      }
      if (!_lan?._running) return { ok: false, error: 'LAN not running' };
    }

    try {
      const session = getSession ? getSession() : null;
      if (!session) return { ok: false, error: 'No session' };
      const cookies = await session.cookies.get({ url: 'https://patrins.com' });
      const tok = cookies.find(c => c.name === 'token');
      if (!tok) return { ok: false, error: 'Not logged in' };

      const https = require('https');
      const os    = require('os');
      const body  = JSON.stringify({ ip: _lan.localIP, port: _lan._httpPort, name: os.hostname() });

      return await new Promise((resolve) => {
        const req = https.request({
          hostname: 'patrins.com', path: '/api/lan/announce', method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Cookie': 'token=' + tok.value,
          },
        }, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false }); } });
        });
        req.on('error', e => resolve({ ok: false, error: e.message }));
        req.write(body); req.end();
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('lan-win:pick-file', async () => {
    const result = await dialog.showOpenDialog({ title: 'Select file to send', properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('lan-win:send-file', async (event, { peerId, filePath }) => {
    if (!_lan) return { ok: false, error: 'LAN not running' };
    return _lan.sendFile(peerId, filePath);
  });

  ipcMain.on('lan-win:close', () => hideLanWindow());
}

module.exports = { showLanWindow, hideLanWindow, getLanWindow, initLanWindowIPC, pushPeers, pushSendProgress, pushSendDone, pushIncoming, pushReceiveProgress, pushFileReceived };
