const { app, BrowserWindow, shell, ipcMain, dialog, Menu, clipboard, net, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { createTray } = require('./tray');
const SyncEngine = require('./sync');

// ── Lightweight profile ───────────────────────────────────────────────────────
app.commandLine.appendSwitch('disk-cache-size', String(50 * 1024 * 1024)); // 50 MB disk cache cap
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');       // 256 MB renderer heap cap

const DASHBOARD_URL = 'https://patrins.com/dashboard';
const UPDATE_URL = 'https://patrins.com/updates/';
const DESKTOP_CALLBACK_URL = 'https://patrins.com/api/auth/desktop-callback';

const store = new Store();

let mainWindow = null;
let tray = null;

// ── Sync engine ───────────────────────────────────────────────────────────────
const sync = new SyncEngine(store, () => mainWindow?.webContents?.session);

sync.on('status', (data) => {
  mainWindow?.webContents?.send('sync:status', data);
  // Update tray tooltip on status changes
  if (tray) {
    const labels = { 'up-to-date': 'Patrins — Synced', syncing: 'Patrins — Syncing…', paused: 'Patrins — Sync paused', error: 'Patrins — Sync error', stopped: 'Patrins' };
    try { tray.setToolTip(labels[data.state] || 'Patrins'); } catch (_) {}
  }
});

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', (event, commandLine) => {
  const deepLink = commandLine.find(arg => arg.startsWith('patrins://'));
  if (deepLink) handleDeepLink(deepLink);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function handleDeepLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'auth') {
      const token = parsed.searchParams.get('token');
      if (token) {
        mainWindow?.loadURL(`${DESKTOP_CALLBACK_URL}?token=${encodeURIComponent(token)}`);
        mainWindow?.show();
        mainWindow?.focus();
      }
    } else if (parsed.hostname === 'download') {
      const fileId = parsed.searchParams.get('fileId');
      const name   = parsed.searchParams.get('name') || 'download';
      const key    = parsed.searchParams.get('key') || null;
      // Validate deep link params before passing to executeJavaScript
      if (fileId && /^[a-zA-Z0-9_-]{1,64}$/.test(fileId)) {
        const safeName = name.replace(/[^\w\s.\-()[\]]/g, '').slice(0, 255) || 'download';
        const safeKey  = key && /^[a-fA-F0-9]{1,128}$/.test(key) ? key : null;
        triggerDesktopDownload(fileId, safeName, safeKey);
      }
    }
  } catch (_) {}
}

function triggerDesktopDownload(fileId, fileName, keyString) {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();

  const code = `typeof window.startDownload === 'function' && window.startDownload(${JSON.stringify(fileId)}, ${JSON.stringify(keyString)}, ${JSON.stringify(fileName)})`;

  if (mainWindow.webContents.getURL().includes('patrins.com/dashboard')) {
    mainWindow.webContents.executeJavaScript(code).catch(() => {});
  } else {
    mainWindow.loadURL(DASHBOARD_URL);
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.executeJavaScript(code).catch(() => {});
    });
  }
}

// ── WebDAV Drive auto-mount ────────────────────────────────────────────────────

let davDriveLetter = null;
let davMounting    = false; // mutex — prevents both did-navigate + did-finish-load firing concurrently
const DAV_LOG = path.join(app.getPath('userData'), 'dav-mount.log');

function davLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(path.dirname(DAV_LOG), { recursive: true });
    fs.appendFileSync(DAV_LOG, line);
  } catch (_) {}
  console.log('[WebDAV]', msg);
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
  } catch (_) {}
}

const SYS32 = 'C:\\Windows\\System32';
const PS    = `${SYS32}\\WindowsPowerShell\\v1.0\\powershell.exe`;
const WIN_ENV = {
  ...process.env,
  PATH: `${process.env.PATH || ''};${SYS32};C:\\Windows;${SYS32}\\WindowsPowerShell\\v1.0`,
};

function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true, shell: true, env: WIN_ENV }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

async function fetchDavToken() {
  return new Promise((resolve, reject) => {
    const req = net.request({
      method: 'GET',
      url: 'https://patrins.com/api/dav/token',
      session: mainWindow.webContents.session,
      useSessionCookies: true,
    });
    let body = '';
    req.on('response', (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error('Bad JSON')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function ensureWebClient() {
  const qout = await runCmd('sc query WebClient').catch(() => '');
  const state = (qout.match(/STATE\s*:\s*\d+\s+(\w+)/) || [])[1];
  davLog(`WebClient state: ${state || 'not found'}`);
  if (!state) return false; // not installed at all

  const setupVersion = store.get('davSetupVersion', 0);

  if (state === 'RUNNING' && setupVersion >= 2) return true;

  // Need elevation: first time setup OR WebClient stopped OR upgrading setup version
  davLog(`Running setup v2 via UAC (current version: ${setupVersion})...`);
  notify('Patrins Drive Setup', 'Click Yes in the system dialog to enable your Patrins Drive.');

  try {
    // Single UAC prompt:
    //   1. Set WebClient to auto-start on boot
    //   2. Raise file size limit from 50 MB → 4 GB (fixes error 0x800700DF)
    //   3. Raise concurrent connections per server from 2 → 20 (fixes Explorer freeze)
    //   4. Start the service (or restart if already running)
    const cmds = [
      'sc config WebClient start= auto',
      'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters" /v FileSizeLimitInBytes /t REG_DWORD /d 4294967295 /f',
      'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters" /v MaxConcurrentConnectionsPerServer /t REG_DWORD /d 20 /f',
      'sc stop WebClient',
      'sc start WebClient',
    ].join(' && ');
    await runCmd(`"${PS}" -Command "Start-Process cmd -ArgumentList '/c ${cmds}' -Verb RunAs -Wait"`);
    await new Promise(r => setTimeout(r, 2500));
    const q2 = await runCmd('sc query WebClient').catch(() => '');
    const s2 = (q2.match(/STATE\s*:\s*\d+\s+(\w+)/) || [])[1];
    davLog(`WebClient after setup: ${s2}`);
    if (s2 === 'RUNNING') {
      store.set('davSetupVersion', 2);
      return true;
    }
    return false;
  } catch (err) {
    davLog(`Setup failed or denied: ${err.message.split('\n')[0]}`);
    return false;
  }
}

async function mountDavDrive() {
  if (process.platform !== 'win32') return;
  if (davDriveLetter) return; // already mounted
  if (davMounting) return;    // concurrent call guard
  davMounting = true;

  davLog('mountDavDrive() called');

  let info;
  try {
    info = await fetchDavToken();
    davLog(`Got DAV token for ${info?.email}`);
  } catch (err) {
    davLog(`fetchDavToken failed: ${err.message}`);
    return;
  }
  if (!info?.token || !info?.email) { davLog('No token/email in response'); return; }
  // Validate token and email before embedding in shell command
  if (!/^[a-f0-9]{48}$/.test(info.token)) { davLog('Invalid token format, aborting mount'); return; }
  if (!/^[^"&|;`$<>\r\n]{1,254}$/.test(info.email)) { davLog('Invalid email format, aborting mount'); return; }

  const running = await ensureWebClient();
  if (!running) {
    davLog('WebClient not running, aborting mount');
    notify('Patrins Drive', 'Could not start WebDAV service. Drive not mounted.');
    return;
  }

  try {
    for (const letter of ['P', 'Q', 'R', 'S', 'T']) {
      await runCmd(`net use ${letter}: /delete /y`).catch(() => {});
      try {
        const cmd = `net use ${letter}: \\\\patrins.com@SSL\\dav "${info.token}" /user:"${info.email}" /persistent:no`;
        davLog(`Trying ${letter}:`);
        await runCmd(cmd);
        davDriveLetter = letter;
        davLog(`Mounted at ${letter}:`);
        notify('Patrins Drive connected', `Your files are at ${letter}: in File Explorer`);
        // HKCU registry fixes — no UAC required
        runCmd([
          // Enable Explorer thumbnails for network drives
          'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v IconsOnly /t REG_DWORD /d 0 /f',
          'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v NoNetCrawling /t REG_DWORD /d 0 /f',
          // Add patrins.com to Trusted Sites zone — suppresses "files might be harmful" warning on every file op
          'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\ZoneMap\\Domains\\patrins.com" /v https /t REG_DWORD /d 2 /f',
          'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\ZoneMap\\Domains\\patrins.com" /v * /t REG_DWORD /d 2 /f',
        ].join(' && ')).catch(() => {});
        return;
      } catch (err) {
        davLog(`${letter}: failed — ${err.message.split('\n')[0]}`);
      }
    }
    davLog('All letters failed');
    notify('Patrins Drive', 'Could not mount — check %APPDATA%\\Patrins\\dav-mount.log');
  } finally {
    davMounting = false;
  }
}

async function unmountDavDrive() {
  if (!davDriveLetter) return;
  await runCmd(`net use ${davDriveLetter}: /delete /y`).catch(() => {});
  davDriveLetter = null;
}

function registerWindowShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const key = String(input.key || '').toLowerCase();
    const code = String(input.code || '');
    const noModifiers = !input.control && !input.alt && !input.meta && !input.shift;
    const onlyCtrl = input.control && !input.alt && !input.meta && !input.shift;
    const onlyAlt = input.alt && !input.control && !input.meta && !input.shift;

    if (onlyAlt && (key === 'arrowleft' || key === 'left' || code === 'ArrowLeft')) {
      event.preventDefault();
      if (win.webContents.canGoBack()) win.webContents.goBack();
      return;
    }

    if (onlyAlt && (key === 'arrowright' || key === 'right' || code === 'ArrowRight')) {
      event.preventDefault();
      if (win.webContents.canGoForward()) win.webContents.goForward();
      return;
    }

    if ((noModifiers && (key === 'f5' || code === 'F5')) || (onlyCtrl && key === 'r')) {
      event.preventDefault();
      win.webContents.reload();
      return;
    }

    if (noModifiers && key === 'escape') {
      event.preventDefault();
      if (win.webContents.canGoBack()) win.webContents.goBack();
    }
  });
}

function createWindow() {
  const bounds = store.get('windowBounds', { width: 1280, height: 820 });

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0E0F14',
    icon: path.join(__dirname, '../assets/icon.ico'),
    autoHideMenuBar: true,
    title: 'Patrins',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
      backgroundThrottling: false,
      v8CacheOptions: 'bypassHeatCheck',
    },
  });

  registerWindowShortcuts(mainWindow);

  // Intercept at network layer (catches 302 redirects, not just link clicks)
  mainWindow.webContents.session.webRequest.onBeforeRequest(
    { urls: ['*://patrins.com/api/auth/google*', '*://accounts.google.com/*'] },
    (details, callback) => {
      const { url, resourceType } = details;

      // Inject desktop=1 so the server knows to use the deep-link callback flow
      if (url.includes('/api/auth/google') && !url.includes('desktop=1')) {
        callback({ redirectURL: url + (url.includes('?') ? '&' : '?') + 'desktop=1' });
        return;
      }

      // Catch the 302 redirect to Google — open in system browser, show waiting screen
      if (url.includes('accounts.google.com') && resourceType === 'mainFrame') {
        shell.openExternal(url);
        setImmediate(() => mainWindow.loadFile(path.join(__dirname, 'waiting-login.html')));
        callback({ cancel: true });
        return;
      }

      callback({});
    }
  );

  // Use a Chrome user-agent — removes "Electron" string that can cause throttling/detection
  mainWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  mainWindow.loadURL(DASHBOARD_URL);

  // window.open() calls: load patrins.com popups in the main window (no URL bar to get stuck),
  // everything else goes to the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const resolved = url.startsWith('/') ? `https://patrins.com${url}` : url;
    if (resolved.startsWith('https://patrins.com') || resolved.startsWith('http://patrins.com')) {
      mainWindow.loadURL(resolved);
      return { action: 'deny' };
    }
    // Only open http/https in system browser — block ms-msdt://, file://, etc.
    if (resolved.startsWith('https://') || resolved.startsWith('http://')) {
      shell.openExternal(resolved);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Analytics breaks inside the app — open in system browser
    if (url.includes('patrins.com/analytics')) {
      event.preventDefault();
      shell.openExternal(url);
      return;
    }

    const isPatrins = url.startsWith('https://patrins.com') || url.startsWith('http://patrins.com');
    if (!isPatrins) {
      event.preventDefault();
      // Only open http/https URLs externally — block file:, data:, custom protocols
      if (url.startsWith('https://') || url.startsWith('http://')) {
        shell.openExternal(url);
      }
    }
  });

  // Clear stale disk cache weekly (keeps footprint small, runs once per week in background)
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - store.get('lastCacheClear', 0) > WEEK) {
    mainWindow.webContents.session.clearCache().then(() => store.set('lastCacheClear', Date.now())).catch(() => {});
  }

  // Taskbar loading indicator
  mainWindow.webContents.on('did-start-loading', () => mainWindow.setProgressBar(2));
  mainWindow.webContents.on('did-stop-loading', () => mainWindow.setProgressBar(-1));

  // Show download progress on taskbar
  mainWindow.webContents.session.on('will-download', (event, item) => {
    item.on('updated', (e, state) => {
      if (state === 'progressing' && !item.isPaused() && item.getTotalBytes() > 0) {
        mainWindow.setProgressBar(item.getReceivedBytes() / item.getTotalBytes());
      }
    });
    item.once('done', () => mainWindow.setProgressBar(-1));
  });

  // Auto-mount WebDAV drive + start sync when user lands on dashboard (logged in)
  mainWindow.webContents.on('did-navigate', (event, url) => {
    if (url.includes('patrins.com/dashboard')) {
      mountDavDrive();
      if (store.get('syncEnabled', false) && store.get('syncFolder')) sync.start();
    }
  });
  // Backup trigger: did-finish-load fires more reliably on initial cold load
  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow.webContents.getURL();
    if (url.includes('patrins.com/dashboard')) {
      mountDavDrive();
      if (store.get('syncEnabled', false) && store.get('syncFolder') && !sync.watcher) sync.start();
    }
  });

  // Offline / connection failed
  mainWindow.webContents.on('did-fail-load', (event, errorCode) => {
    if (errorCode === -3) return; // aborted navigation, ignore
    mainWindow.loadFile(path.join(__dirname, 'offline.html'));
  });

  // Right-click context menu
  mainWindow.webContents.on('context-menu', (event, params) => {
    const items = [
      { label: 'Back', enabled: params.canGoBack, click: () => mainWindow.webContents.goBack() },
      { label: 'Forward', enabled: params.canGoForward, click: () => mainWindow.webContents.goForward() },
      { label: 'Reload', click: () => mainWindow.webContents.reload() },
      { type: 'separator' },
    ];
    if (params.selectionText) {
      items.push({ label: 'Copy', click: () => clipboard.writeText(params.selectionText) });
    }
    if (params.linkURL) {
      const isSafeLink = params.linkURL.startsWith('https://') || params.linkURL.startsWith('http://');
      items.push(
        { label: 'Open Link in Browser', enabled: isSafeLink, click: () => { if (isSafeLink) shell.openExternal(params.linkURL); } },
        { label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) }
      );
    }
    Menu.buildFromTemplate(items).popup();
  });

  // Save window bounds on resize/move
  const saveBounds = () => {
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Minimize to tray on close
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_URL });

  autoUpdater.on('error', () => {});
  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents?.send('update:available', { version: info.version });
  });
  autoUpdater.on('download-progress', (p) => {
    mainWindow?.webContents?.send('update:progress', {
      percent:       Math.round(p.percent),
      transferred:   p.transferred,
      total:         p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents?.send('update:downloaded', { version: info.version });
  });

  autoUpdater.checkForUpdates().catch(() => {});

  // Re-check every 4 hours
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.patrins.desktop'); // required for Windows toast notifications
  app.setAsDefaultProtocolClient('patrins');
  createWindow();
  tray = createTray(mainWindow);
  setupAutoUpdater();

  // Handle deep link if app was launched via patrins:// URL
  const deepLinkArg = process.argv.find(arg => arg.startsWith('patrins://'));
  if (deepLinkArg) handleDeepLink(deepLinkArg);
});

app.on('before-quit', (event) => {
  if (davDriveLetter) {
    event.preventDefault();
    unmountDavDrive().finally(() => {
      app.isQuitting = true;
      app.quit();
    });
  } else {
    app.isQuitting = true;
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('retry-connection', () => mainWindow?.loadURL(DASHBOARD_URL));
ipcMain.on('show-in-folder', (event, filePath) => shell.showItemInFolder(filePath));

// ── Sync IPC ──────────────────────────────────────────────────────────────────
ipcMain.handle('sync:get-status', () => ({
  ...sync.getStatus(),
  enabled: store.get('syncEnabled', false),
  folder:  store.get('syncFolder') || null,
}));

ipcMain.handle('sync:pick-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Sync Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('sync:set-config', async (event, { enabled, folder }) => {
  if (folder !== undefined) store.set('syncFolder', folder);
  if (enabled !== undefined) store.set('syncEnabled', enabled);

  sync.stop();
  if (store.get('syncEnabled', false) && store.get('syncFolder')) {
    await sync.start();
  }
  return { ok: true };
});

ipcMain.on('sync:pause',  () => sync.pause());
ipcMain.on('sync:resume', () => sync.resume());

ipcMain.on('update:install', () => autoUpdater.quitAndInstall(false, true));
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:check', async () => {
  try { await autoUpdater.checkForUpdates(); } catch (_) {}
});

// ── Desktop download engine (IDM-style: N threads → OS temp files → assemble) ─
const _dlActive = new Map(); // downloadId → { cancelled, activeReqs }

ipcMain.on('patrins-download-cancel', (event, downloadId) => {
  const state = _dlActive.get(downloadId);
  if (!state) return;
  state.cancelled = true;
  for (const req of state.activeReqs) { try { req.abort(); } catch (_) {} }
});

ipcMain.handle('patrins-download', async (event, { downloadId, fileId, fileName, fileSize }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('downloads'), fileName || 'download'),
    buttonLabel: 'Save',
  });
  if (canceled) return { status: 'cancelled' };

  const tmpDir = path.join(os.tmpdir(), `patrins_${downloadId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const SEG_SIZE  = 4 * 1024 * 1024; // 4 MB segments
  const POOL_SIZE = 8;                // 8 concurrent HTTP/2 streams
  const segments  = [];
  let pos = 0, idx = 0;
  while (pos < fileSize) {
    const end = Math.min(pos + SEG_SIZE - 1, fileSize - 1);
    segments.push({ idx, start: pos, end, tmpPath: path.join(tmpDir, `seg_${idx}.tmp`) });
    pos = end + 1; idx++;
  }

  const state = { cancelled: false, activeReqs: new Set() };
  _dlActive.set(downloadId, state);

  event.sender.send('download-progress', {
    downloadId, phase: 'start', total: fileSize, segments: segments.length,
  });

  let dlBytes = 0, lastSend = 0;
  function sendProgress() {
    const now = Date.now();
    if (now - lastSend < 120) return;
    lastSend = now;
    event.sender.send('download-progress', { downloadId, phase: 'progress', downloaded: dlBytes, total: fileSize });
  }

  async function fetchSeg(seg, attempt) {
    attempt = attempt || 1;
    if (state.cancelled) return;
    return new Promise((resolve, reject) => {
      const req = net.request({
        method: 'GET',
        url: `https://patrins.com/api/stream/${fileId}`,
        session: mainWindow.webContents.session,
        useSessionCookies: true,
      });
      req.setHeader('Range', `bytes=${seg.start}-${seg.end}`);
      req.setHeader('Cache-Control', 'no-store');
      state.activeReqs.add(req);

      req.on('response', (res) => {
        if (res.statusCode !== 206 && res.statusCode !== 200) {
          state.activeReqs.delete(req);
          if (attempt < 4 && !state.cancelled)
            return setTimeout(() => fetchSeg(seg, attempt + 1).then(resolve).catch(reject), 400 * attempt);
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const ws = fs.createWriteStream(seg.tmpPath);
        res.on('data', (chunk) => {
          if (state.cancelled) return;
          ws.write(chunk);
          dlBytes += chunk.length;
          sendProgress();
        });
        res.on('end', () => {
          state.activeReqs.delete(req);
          ws.end(() => resolve());
        });
        res.on('error', (err) => {
          state.activeReqs.delete(req);
          ws.destroy();
          if (attempt < 4 && !state.cancelled)
            return setTimeout(() => fetchSeg(seg, attempt + 1).then(resolve).catch(reject), 400 * attempt);
          reject(err);
        });
      });
      req.on('error', (err) => {
        state.activeReqs.delete(req);
        if (attempt < 4 && !state.cancelled)
          return setTimeout(() => fetchSeg(seg, attempt + 1).then(resolve).catch(reject), 400 * attempt);
        reject(err);
      });
      req.end();
    });
  }

  async function dlPool(tasks, n) {
    const q = [...tasks];
    await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
      while (q.length) await q.shift()();
    }));
  }

  function cleanup() {
    _dlActive.delete(downloadId);
    for (const seg of segments) fs.unlink(seg.tmpPath, () => {});
    setTimeout(() => fs.rmdir(tmpDir, () => {}), 1000);
  }

  try {
    await dlPool(segments.map(seg => () => fetchSeg(seg)), POOL_SIZE);

    if (state.cancelled) { cleanup(); return { status: 'cancelled' }; }

    event.sender.send('download-progress', { downloadId, phase: 'assembling' });

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(filePath);
      ws.on('error', reject);
      (async () => {
        for (const seg of segments) {
          await new Promise((res, rej) => {
            const rs = fs.createReadStream(seg.tmpPath);
            rs.on('error', rej);
            rs.on('end', res);
            rs.pipe(ws, { end: false });
          });
        }
        ws.end();
        ws.on('finish', resolve);
      })().catch(reject);
    });

    cleanup();
    event.sender.send('download-progress', { downloadId, phase: 'done', filePath });
    return { status: 'done', filePath };

  } catch (err) {
    cleanup();
    event.sender.send('download-progress', { downloadId, phase: 'error', error: err.message });
    return { status: 'error', error: err.message };
  }
});
