const { BrowserWindow, ipcMain, clipboard, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const tus = require('tus-js-client');

let dropWin = null;
let _getToken = null;

function showDropWindow() {
  if (dropWin && !dropWin.isDestroyed()) {
    if (!dropWin.isVisible()) dropWin.show();
    dropWin.focus();
    return;
  }

  const { workAreaSize, workArea } = screen.getPrimaryDisplay();
  const W = 320, H = 380;
  const x = (workArea.x || 0) + workAreaSize.width  - W - 20;
  const y = (workArea.y || 0) + workAreaSize.height - H - 20;

  dropWin = new BrowserWindow({
    width: W, height: H, x, y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'drop-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  dropWin.loadFile(path.join(__dirname, 'drop.html'));
  dropWin.on('closed', () => { dropWin = null; });
}

function hideDropWindow() {
  if (dropWin && !dropWin.isDestroyed()) dropWin.hide();
}

function initDropIPC(getToken) {
  _getToken = getToken;

  ipcMain.handle('drop:pick-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose a file to upload',
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return null;
    const fp = filePaths[0];
    return { path: fp, name: path.basename(fp), size: fs.statSync(fp).size };
  });

  ipcMain.handle('drop:upload', async (event, { filePath, fileName, fileSize }) => {
    if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'Invalid path' };
    // Resolve relative paths & validate
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) return { ok: false, error: 'File not found' };
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return { ok: false, error: 'Not a file' };
    } catch (_) { return { ok: false, error: 'Cannot stat file' }; }

    let token;
    try { token = await _getToken(); }
    catch (e) { return { ok: false, error: 'Not logged in — open Patrins first' }; }

    const name = fileName || path.basename(abs);
    const size = fileSize || fs.statSync(abs).size;

    return new Promise((resolve) => {
      let fileId = null;
      const upload = new tus.Upload(fs.createReadStream(abs), {
        endpoint:    'https://patrins.com/api/tus/',
        uploadSize:  size,
        chunkSize:   10 * 1024 * 1024,
        retryDelays: [0, 2000, 5000],
        headers:     { Cookie: 'token=' + token },
        metadata:    { filename: name, filetype: 'application/octet-stream', isTemp: 'false' },
        onProgress:  (uploaded, total) => {
          const pct = total ? Math.round((uploaded / total) * 100) : 0;
          event.sender.send('drop:progress', { name, pct });
        },
        onAfterResponse: (_req, res) => {
          const id = res.getHeader('X-File-Id');
          if (id) fileId = id;
        },
        onError:   (err)  => resolve({ ok: false, error: err.message }),
        onSuccess: ()     => {
          const link = `https://patrins.com/f/${fileId}`;
          clipboard.writeText(link);
          resolve({ ok: true, fileId, link });
        },
      });
      upload.start();
    });
  });

  ipcMain.on('drop:close', () => hideDropWindow());
}

module.exports = { showDropWindow, hideDropWindow, initDropIPC };
