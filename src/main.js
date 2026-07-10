const { app, BrowserWindow, shell, ipcMain, dialog, Menu, clipboard, net, Notification, screen, powerMonitor, protocol } = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const { createTray, updateTrayMenu } = require('./tray');
const { showDropWindow, initDropIPC } = require('./drop-window');
const { showLanWindow, getLanWindow, initLanWindowIPC, pushPeers, pushSendProgress, pushSendDone, pushIncoming, pushReceiveProgress, pushFileReceived } = require('./lan-window');
const { registerContextMenu } = require('./context-menu');
const SyncEngine = require('./sync');
const LanEngine  = require('./lan');
const logger = require('./logger');

// ── Lightweight profile ───────────────────────────────────────────────────────
app.commandLine.appendSwitch('disk-cache-size', String(50 * 1024 * 1024)); // 50 MB disk cache cap
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');       // 256 MB renderer heap cap

const DASHBOARD_URL = 'https://patrins.com/dashboard';
const UPDATE_URL = 'https://patrins.com/updates/';
const DESKTOP_CALLBACK_URL = 'https://patrins.com/api/auth/desktop-callback';

const store = new Store();

let mainWindow = null;
let tray = null;

// ── UI cache (zero-latency load) ───────────────────────────────────────────────
const UI_CACHE_PATH    = path.join(app.getPath('userData'), 'dashboard-cache.html');
const UI_CACHE_META    = path.join(app.getPath('userData'), 'dashboard-cache-meta.json');
const UI_CACHE_MAX_AGE = 60 * 60 * 1000; // 1 hour — refresh from network after this

function readCacheMeta() {
  try { return JSON.parse(fs.readFileSync(UI_CACHE_META, 'utf8')); } catch { return null; }
}

function isCacheValid() {
  const meta = readCacheMeta();
  return meta && (Date.now() - meta.savedAt) < UI_CACHE_MAX_AGE && fs.existsSync(UI_CACHE_PATH);
}

async function saveUICache(webContents) {
  try {
    let html = await webContents.executeJavaScript('document.documentElement.outerHTML');
    // Sanity check — don't cache empty or error pages
    if (!html || html.length < 10000) return;
    if (!html.includes('id="app"') && !html.includes('class="sidebar"') && !html.includes('dashboard')) return;
    // Inject <base> so relative URLs resolve to patrins.com from file://
    html = html.replace('<head>', '<head>\n<base href="https://patrins.com/">');
    // Strip third-party tracking/analytics scripts that fail outside the CDN context
    html = html.replace(/<script[^>]*cdn-cgi[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*cloudflare[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<script[^>]*beacon\.min[^>]*><\/script>/gi, '');
    html = html.replace(/https:\/\/[^"']*\/cdn-cgi\/[^"']*/g, '');
    fs.writeFileSync(UI_CACHE_PATH, html, 'utf8');
    fs.writeFileSync(UI_CACHE_META, JSON.stringify({ savedAt: Date.now() }), 'utf8');
  } catch (_) {}
}

function clearUICache() {
  try { fs.unlinkSync(UI_CACHE_PATH); } catch (_) {}
  try { fs.unlinkSync(UI_CACHE_META); } catch (_) {}
}

// ── Primary sync engine ────────────────────────────────────────────────────────
const sync = new SyncEngine(store, () => mainWindow?.webContents?.session);

// ── Watch-folder engines (one per extra watched folder) ────────────────────────
const watchSyncs = new Map(); // absPath → SyncEngine

function getWatchFolders() { return store.get('watchFolders', []); }

function addWatchFolder(folderPath) {
  const abs = path.resolve(folderPath);
  if (watchSyncs.has(abs)) return false;
  if (!fs.existsSync(abs)) return false;

  const id = require('crypto').createHash('md5').update(abs).digest('hex').slice(0, 8);
  const engine = new SyncEngine(store, () => mainWindow?.webContents?.session, abs, id);
  watchSyncs.set(abs, engine);

  engine.on('status', (data) => {
    mainWindow?.webContents?.send('sync:watch-status', { folder: abs, ...data });
    updateTrayMenu(undefined, undefined, [...watchSyncs.keys()].map(p => ({
      path: p, state: watchSyncs.get(p).getStatus().state,
    })));
  });

  // Start if user is logged in (session has token)
  engine.start().catch(e => console.error('[WatchFolder] Start failed:', e.message));

  const folders = getWatchFolders();
  if (!folders.includes(abs)) store.set('watchFolders', [...folders, abs]);
  notify('Watch Folder Added', path.basename(abs) + ' is now syncing to Patrins.');
  mainWindow?.webContents?.send('sync:watch-folders-changed', getWatchFolders());
  return true;
}

function removeWatchFolder(folderPath) {
  const abs = path.resolve(folderPath);
  const engine = watchSyncs.get(abs);
  if (engine) { engine.stop(); watchSyncs.delete(abs); }
  store.set('watchFolders', getWatchFolders().filter(f => f !== abs));
  mainWindow?.webContents?.send('sync:watch-folders-changed', getWatchFolders());
}

// ── LAN P2P engine ─────────────────────────────────────────────────────────────
const lan = new LanEngine(store);

lan.on('incoming-request', async ({ requestId, senderName, fileName, fileSize }) => {
  pushIncoming({ requestId, senderName, fileName, fileSize });
  // Show native dialog — user accepts or denies
  try {
    const MB = (fileSize / 1048576).toFixed(1);
    const GB = (fileSize / 1073741824).toFixed(2);
    const sizeStr = fileSize >= 1073741824 ? `${GB} GB` : `${MB} MB`;
    const { response } = await dialog.showMessageBox({
      type:      'question',
      buttons:   ['Accept', 'Deny'],
      defaultId: 0,
      cancelId:  1,
      title:     'Incoming Local Transfer',
      message:   `${senderName} wants to send you a file`,
      detail:    `"${fileName}"  ·  ${sizeStr}\n\nFile will be saved to your Downloads folder.`,
      icon:      path.join(__dirname, '../assets/icon.ico'),
    });
    lan.respondToRequest(requestId, response === 0);
  } catch (_) {
    lan.respondToRequest(requestId, false);
  }
});

lan.on('file-received', ({ from, fileName, savePath }) => {
  notify('Transfer complete', `"${fileName}" from ${from} — saved to Downloads`);
  mainWindow?.webContents?.send('lan:file-received', { from, fileName, savePath });
  pushFileReceived({ from, fileName, savePath });
});
lan.on('receive-progress', (data) => { mainWindow?.webContents?.send('lan:receive-progress', data); pushReceiveProgress(data); });
lan.on('peer-found',    (peers) => { mainWindow?.webContents?.send('lan:peers', peers); pushPeers(peers); });
lan.on('peers-changed', (peers) => { mainWindow?.webContents?.send('lan:peers', peers); pushPeers(peers); });
lan.on('send-progress', (data)  => pushSendProgress(data));
lan.on('send-done',     (data)  => pushSendDone(data));

sync.on('status', (data) => {
  mainWindow?.webContents?.send('sync:status', data);
  const labels = { 'up-to-date': 'Patrins — Synced', syncing: 'Patrins — Syncing…', paused: 'Patrins — Sync paused', error: 'Patrins — Sync error', stopped: 'Patrins' };
  if (tray) try { tray.setToolTip(labels[data.state] || 'Patrins'); } catch (_) {}
  updateTrayMenu(data.state, undefined);
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
      if (fileId && /^[a-zA-Z0-9_-]{1,64}$/.test(fileId)) {
        const safeName = name.replace(/[^\w\s.\-()[\]]/g, '').slice(0, 255) || 'download';
        const safeKey  = key && /^[a-fA-F0-9]{1,128}$/.test(key) ? key : null;
        triggerDesktopDownload(fileId, safeName, safeKey);
      }

    } else if (parsed.hostname === 'upload') {
      // Right-click → Upload to Patrins
      const filePath = parsed.searchParams.get('path');
      if (filePath) uploadFileViaContextMenu(decodeURIComponent(filePath));

    } else if (parsed.hostname === 'uploadhere') {
      // Right-click background → Upload files here
      const folderPath = parsed.searchParams.get('path');
      if (folderPath) {
        mainWindow?.show(); mainWindow?.focus();
        mainWindow?.webContents?.send('shell:upload-here', decodeURIComponent(folderPath));
      }

    } else if (parsed.hostname === 'watch') {
      // Right-click folder → Watch with Patrins
      const folderPath = parsed.searchParams.get('path');
      if (folderPath) {
        const abs = path.resolve(decodeURIComponent(folderPath));
        addWatchFolder(abs);
        mainWindow?.show();
        mainWindow?.focus();
      }
    }
  } catch (_) {}
}

async function uploadFileViaContextMenu(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) { notify('Patrins', 'File not found: ' + path.basename(abs)); return; }

  notify('Patrins', 'Uploading ' + path.basename(abs) + '…');
  mainWindow?.show();

  let token;
  try { token = await sync._getToken(); }
  catch (_) {
    // Not logged in — open dashboard and prompt user to log in first
    mainWindow?.loadURL(DASHBOARD_URL);
    notify('Patrins', 'Please log in first, then try again.');
    return;
  }

  const tus     = require('tus-js-client');
  const name    = path.basename(abs);
  const size    = fs.statSync(abs).size;

  return new Promise((resolve) => {
    let fileId = null;
    const upload = new tus.Upload(fs.createReadStream(abs), {
      endpoint:    'https://patrins.com/api/tus/',
      uploadSize:  size,
      chunkSize:   10 * 1024 * 1024,
      retryDelays: [0, 3000, 5000],
      headers:     { Cookie: 'token=' + token },
      metadata:    { filename: name, filetype: 'application/octet-stream', isTemp: 'false' },
      onAfterResponse: (_req, res) => { const id = res.getHeader('X-File-Id'); if (id) fileId = id; },
      onError:   (err) => { notify('Upload Failed', name + ': ' + err.message.split('\n')[0]); resolve(); },
      onSuccess: () => {
        const link = `https://patrins.com/f/${fileId}`;
        clipboard.writeText(link);
        notify('Uploaded! Link copied', name);
        resolve();
      },
    });
    upload.start();
  });
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

  try {
    let info;
    try {
      info = await fetchDavToken();
      davLog(`Got DAV token for ${info?.email}`);
    } catch (err) {
      davLog(`fetchDavToken failed: ${err.message}`);
      logger.log('dav_token_error', { error: err.message });
      return;
    }
    if (!info?.token || !info?.email) { davLog('No token/email in response'); return; }
    // Validate token and email before embedding in shell command
    if (!/^[a-f0-9]{48}$/.test(info.token)) { davLog('Invalid token format, aborting mount'); return; }
    if (!/^[^"&|;`$<>\r\n]{1,254}$/.test(info.email)) { davLog('Invalid email format, aborting mount'); return; }

    const running = await ensureWebClient();
    if (!running) {
      davLog('WebClient not running, aborting mount');
      logger.log('dav_service_error', {});
      notify('Patrins Drive', 'Could not start WebDAV service. Drive not mounted.');
      return;
    }

    for (const letter of ['P', 'Q', 'R', 'S', 'T']) {
      await runCmd(`net use ${letter}: /delete /y`).catch(() => {});
      try {
        const cmd = `net use ${letter}: \\\\patrins.com@SSL\\dav "${info.token}" /user:"${info.email}" /persistent:no`;
        davLog(`Trying ${letter}:`);
        await runCmd(cmd);
        davDriveLetter = letter;
        davLog(`Mounted at ${letter}:`);
        logger.log('dav_mounted', { letter });
        notify('Patrins Drive connected', `Your files are at ${letter}: in File Explorer`);
        updateTrayMenu(undefined, letter);
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
        const msg = err.message.split('\n')[0];
        davLog(`${letter}: failed — ${msg}`);
        logger.log('dav_letter_fail', { letter, error: msg });
        // System error 86 = wrong password (bad token), System error 5 = access denied
        // These are auth errors — retrying other letters won't help, fail fast
        if (/error 86|error 5\b|password.*not correct|access.*denied/i.test(msg)) {
          davLog('Auth error — stopping mount attempts');
          notify('Patrins Drive', 'Authentication failed. Reload the app and try again.');
          return;
        }
        // System error 67 = network path not found — server unreachable, no point retrying letters
        if (/error 67|network path/i.test(msg)) {
          davLog('Network path not found — server unreachable');
          notify('Patrins Drive', 'Cannot reach patrins.com. Check your connection.');
          return;
        }
      }
    }
    davLog('All letters failed');
    logger.log('dav_all_failed', {});
    notify('Patrins Drive', 'No available drive letters (P–T all in use). Free a drive letter and use "Mount Drive…" from the tray.');
  } finally {
    davMounting = false;
  }
}

async function unmountDavDrive() {
  if (!davDriveLetter) return;
  await runCmd(`net use ${davDriveLetter}: /delete /y`).catch(() => {});
  davDriveLetter = null;
  updateTrayMenu(undefined, null);
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
      return;
    }

    // F11 — fullscreen toggle
    if (noModifiers && (key === 'f11' || code === 'F11')) {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
      return;
    }

    // Zoom in / out / reset
    if (onlyCtrl && (key === '=' || key === '+' || code === 'Equal')) {
      event.preventDefault();
      win.webContents.setZoomFactor(Math.min(win.webContents.getZoomFactor() + 0.1, 3.0));
      return;
    }
    if (onlyCtrl && (key === '-' || code === 'Minus')) {
      event.preventDefault();
      win.webContents.setZoomFactor(Math.max(win.webContents.getZoomFactor() - 0.1, 0.3));
      return;
    }
    if (onlyCtrl && (key === '0' || code === 'Digit0')) {
      event.preventDefault();
      win.webContents.setZoomFactor(1.0);
      return;
    }

    // Ctrl+F — find in page overlay
    if (onlyCtrl && key === 'f') {
      event.preventDefault();
      win.webContents.executeJavaScript(`
        (function() {
          const existing = document.getElementById('__pfind');
          if (existing) { existing.querySelector('input').select(); return; }
          const wrap = document.createElement('div');
          wrap.id = '__pfind';
          wrap.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483647;background:#1a1a18;border:1px solid #2a2a27;border-top:none;border-right:none;border-radius:0 0 0 6px;padding:6px 10px;display:flex;align-items:center;gap:6px;box-shadow:0 4px 16px rgba(0,0,0,.5);';
          wrap.innerHTML = '<input id="__pfind-input" placeholder="Find in page…" style="background:#111110;color:#e8e6e1;border:1px solid #2a2a27;border-radius:4px;padding:3px 8px;font-size:13px;font-family:inherit;outline:none;width:190px;" />'
            + '<span id="__pfind-count" style="color:#8a8880;font-size:12px;min-width:52px;text-align:center;"></span>'
            + '<button title="Previous (Shift+Enter)" style="background:none;border:none;color:#8a8880;cursor:pointer;font-size:15px;padding:0 2px;line-height:1;">‹</button>'
            + '<button title="Next (Enter)" style="background:none;border:none;color:#8a8880;cursor:pointer;font-size:15px;padding:0 2px;line-height:1;">›</button>'
            + '<button title="Close (Escape)" style="background:none;border:none;color:#8a8880;cursor:pointer;font-size:17px;padding:0 2px;line-height:1;">×</button>';
          document.body.appendChild(wrap);
          const inp = wrap.querySelector('input');
          const [btnPrev, btnNext, btnClose] = wrap.querySelectorAll('button');
          inp.focus();
          inp.addEventListener('input', () => {
            if (inp.value) window.patrinsApp.findInPage(inp.value, {});
            else window.patrinsApp.stopFindInPage();
          });
          inp.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); window.patrinsApp.findInPage(inp.value, { forward: !e.shiftKey, findNext: true }); }
            if (e.key === 'Escape') { e.preventDefault(); btnClose.click(); }
          });
          btnPrev.onclick = () => window.patrinsApp.findInPage(inp.value, { forward: false, findNext: true });
          btnNext.onclick = () => window.patrinsApp.findInPage(inp.value, { forward: true,  findNext: true });
          btnClose.onclick = () => { window.patrinsApp.stopFindInPage(); wrap.remove(); };
          window.patrinsApp.onFindResult(r => {
            const el = document.getElementById('__pfind-count');
            if (el) el.textContent = r && r.matches ? r.activeMatchOrdinal + '/' + r.matches : (r && r.finalUpdate && !r.matches ? 'No results' : '');
          });
        })();
      `).catch(() => {});
      return;
    }
  });
}

function isOnScreen(bounds) {
  return screen.getAllDisplays().some(d => {
    const b = d.bounds;
    return bounds.x < b.x + b.width  && bounds.x + (bounds.width  || 0) > b.x &&
           bounds.y < b.y + b.height && bounds.y + (bounds.height || 0) > b.y;
  });
}

function createWindow() {
  const saved      = store.get('windowBounds', {});
  const bounds     = (saved.x !== undefined && saved.y !== undefined && isOnScreen(saved))
    ? saved
    : { width: 1280, height: 820 };
  const startHidden = process.argv.includes('--hidden');

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
    show: !startHidden,
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

  // ── CORS fix: when HTML is served from file:// (UI cache), spoof Origin so
  // API calls to https://patrins.com look same-origin from the server's perspective
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['https://patrins.com/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      if (!headers['Origin'] || headers['Origin'] === 'null') {
        headers['Origin']  = 'https://patrins.com';
        headers['Referer'] = 'https://patrins.com/dashboard';
      }
      callback({ requestHeaders: headers });
    }
  );

  // ── Intercept at network layer (catches 302 redirects, not just link clicks)
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

  // Show the app-shell splash instantly, then load the live authenticated dashboard.
  // We intentionally NO LONGER load a saved dashboard snapshot from file://: a page
  // served from file:// is a different (opaque) origin from https://patrins.com, so its
  // auth check (`/api/auth/me`) is cross-origin and can silently fail or stall — leaving
  // the window blank with no crash and nothing in the console. app-shell.html gives an
  // instant, reliable first paint; the real UI always comes from the live origin.
  clearUICache(); // purge any snapshot written by older versions
  mainWindow.loadFile(path.join(__dirname, 'app-shell.html'));
  setTimeout(() => { if (!mainWindow?.isDestroyed()) mainWindow.loadURL(DASHBOARD_URL); }, 120);

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
    // Homepage has no use inside the app — always send to login instead
    try {
      const u = new URL(url);
      if ((u.hostname === 'patrins.com' || u.hostname === 'www.patrins.com') &&
          (u.pathname === '/' || u.pathname === '')) {
        event.preventDefault();
        mainWindow.loadURL('https://patrins.com/login');
        return;
      }
    } catch (_) {}

    // Marketing/download pages should open in the system browser, not inside the app
    const externalPaths = ['/download', '/pricing', '/updates/'];
    if (externalPaths.some(p => url.includes('patrins.com' + p))) {
      event.preventDefault();
      shell.openExternal(url);
      return;
    }

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

  // Relay find-in-page results to the renderer's find overlay
  mainWindow.webContents.on('found-in-page', (_, result) => {
    mainWindow.webContents.send('find-result', result);
  });

  // Taskbar loading indicator
  mainWindow.webContents.on('did-start-loading', () => mainWindow.setProgressBar(2));
  mainWindow.webContents.on('did-stop-loading', () => mainWindow.setProgressBar(-1));

  // Show download progress on taskbar
  mainWindow.webContents.session.on('will-download', (event, item, webContents) => {
    // Files received via Local Transfer auto-save to Downloads (no Save-As prompt per file)
    const lw = getLanWindow();
    if (lw && !lw.isDestroyed() && webContents === lw.webContents) {
      try {
        const dir  = app.getPath('downloads');
        const name = item.getFilename() || 'download';
        const ext  = path.extname(name);
        const base = path.basename(name, ext);
        let target = path.join(dir, name);
        let n = 1;
        while (fs.existsSync(target)) target = path.join(dir, `${base} (${n++})${ext}`);
        item.setSavePath(target);
        item.once('done', (e, state) => {
          if (state === 'completed') notify('File received', `${path.basename(target)} — saved to Downloads`);
        });
      } catch (_) {}
    }
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
      // Re-start any watch folder engines
      for (const [fp, engine] of watchSyncs) {
        if (!engine.watcher) engine.start().catch(() => {});
      }
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
  mainWindow.webContents.on('did-fail-load', (event, errorCode, _desc, validatedURL, isMainFrame) => {
    if (errorCode === -3) return; // aborted navigation, ignore
    if (isMainFrame) {
      logger.log('page_load_fail', {
        code:   errorCode,
        target: validatedURL?.includes('patrins.com') ? 'app' : 'ext',
      });
    }
    mainWindow.loadFile(path.join(__dirname, 'offline.html'));
  });

  // Renderer process gone (crash, OOM, killed)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.log('renderer_gone', { reason: details?.reason || 'unknown' });
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
  // Auto-updater only works in packaged builds — skip in dev to avoid spurious errors
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null; // suppress verbose internal logs; we handle events ourselves
  autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_URL });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err?.message || err);
    logger.log('updater_error', { error: err?.message });
  });
  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking for update…');
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info.version);
    mainWindow?.webContents?.send('update:available', { version: info.version });
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log('[updater] up to date:', info.version);
  });
  autoUpdater.on('download-progress', (p) => {
    mainWindow?.webContents?.send('update:progress', {
      percent:        Math.round(p.percent),
      transferred:    p.transferred,
      total:          p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] update downloaded:', info.version);
    mainWindow?.webContents?.send('update:downloaded', { version: info.version });
  });

  autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed:', err?.message));

  // Re-check every 4 hours
  setInterval(
    () => autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed:', err?.message)),
    4 * 60 * 60 * 1000
  );
}

// ── Process-level crash/rejection capture ─────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err?.message);
  logger.log('main_crash', { error: err?.message });
  logger.flush().finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[main] unhandledRejection:', msg);
  logger.log('unhandled_rejection', { error: msg });
});

app.whenReady().then(async () => {
  app.setAppUserModelId('com.patrins.desktop'); // required for Windows toast notifications
  app.setAsDefaultProtocolClient('patrins');

  logger.init(store, app.getVersion());

  // Register in Windows startup — launches hidden to tray on login
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  }

  createWindow();
  const startLan = async () => {
    // Reuse the existing lan:start logic
    let username = os.userInfo().username || 'Desktop';
    try {
      const cookies = await mainWindow.webContents.session.cookies.get({ url: 'https://patrins.com' });
      const tok = cookies.find(c => c.name === 'token');
      if (tok) {
        const info = await new Promise((res, rej) => {
          const req = net.request({ method: 'GET', url: 'https://patrins.com/api/auth/me',
            session: mainWindow.webContents.session, useSessionCookies: true });
          let body = ''; req.on('response', r => { r.on('data', c => body += c); r.on('end', () => { try { res(JSON.parse(body)); } catch { rej(new Error('bad json')); } }); });
          req.on('error', rej); req.end();
        });
        if (info?.display_name) username = info.display_name;
        else if (info?.username) username = info.username;
      }
    } catch (_) {}
    return lan.start(username, app.getPath('downloads'));
  };

  tray = createTray(mainWindow, {
    showDropWindow,
    showLanWindow: () => showLanWindow(startLan),
    mountDrive: () => { davMounting = false; mountDavDrive(); },
  });
  setupAutoUpdater();

  // Re-mount WebDAV drive after PC wakes from sleep.
  // Windows silently disconnects network drives on sleep, so always force a fresh mount
  // regardless of what davDriveLetter says — it reflects what we asked for, not what Windows kept.
  powerMonitor.on('resume', () => {
    davDriveLetter = null;
    updateTrayMenu(undefined, null);
    mountDavDrive();
  });

  // Tray pause/resume clicks relay to sync
  app.on('sync:pause-from-tray',  () => sync.pause());
  app.on('sync:resume-from-tray', () => sync.resume());

  // Drop window IPC (uses sync engine's token getter)
  initDropIPC(() => sync._getToken());

  // LAN window IPC
  initLanWindowIPC(lan, () => mainWindow?.webContents?.session, startLan);

  // Context menu shell extension (Windows only, runs silently in background)
  registerContextMenu().catch(() => {});

  // Restore watch folders from last session; prune any that no longer exist on disk
  const storedFolders = getWatchFolders();
  const validFolders  = storedFolders.filter(fp => fs.existsSync(fp));
  if (validFolders.length !== storedFolders.length) {
    store.set('watchFolders', validFolders); // clean up stale entries
  }
  for (const fp of validFolders) {
    const id = require('crypto').createHash('md5').update(fp).digest('hex').slice(0, 8);
    const engine = new SyncEngine(store, () => mainWindow?.webContents?.session, fp, id);
    watchSyncs.set(fp, engine);
    engine.on('status', (data) => {
      mainWindow?.webContents?.send('sync:watch-status', { folder: fp, ...data });
    });
    // Don't auto-start yet — will start after dashboard login (did-navigate)
  }

  // Handle deep link if app was launched via patrins:// URL
  const deepLinkArg = process.argv.find(arg => arg.startsWith('patrins://'));
  if (deepLinkArg) handleDeepLink(deepLinkArg);
});

app.on('before-quit', (event) => {
  if (davDriveLetter) {
    event.preventDefault();
    logger.shutdown()
      .catch(() => {})
      .finally(() => unmountDavDrive())
      .finally(() => { app.isQuitting = true; app.quit(); });
  } else {
    app.isQuitting = true;
    logger.shutdown().catch(() => {});
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('retry-connection', () => mainWindow?.loadURL(DASHBOARD_URL));
ipcMain.on('show-in-folder', (event, filePath) => shell.showItemInFolder(filePath));

ipcMain.on('find-in-page', (_, text, opts) => {
  if (text) mainWindow?.webContents.findInPage(text, opts);
});
ipcMain.on('stop-find-in-page', () => {
  mainWindow?.webContents.stopFindInPage('clearSelection');
});

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

// ── Watch Folders IPC ──────────────────────────────────────────────────────────
ipcMain.handle('watchfolders:list',   () => getWatchFolders());
ipcMain.handle('watchfolders:add',    async (_, folderPath) => {
  // Show folder picker if no path given
  if (!folderPath) {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Watch Folder', properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled) return { ok: false };
    folderPath = filePaths[0];
  }
  const ok = addWatchFolder(folderPath);
  return { ok, folders: getWatchFolders() };
});
ipcMain.handle('watchfolders:remove', (_, folderPath) => {
  removeWatchFolder(folderPath);
  return { ok: true, folders: getWatchFolders() };
});
ipcMain.handle('watchfolders:status', () => {
  const result = {};
  for (const [fp, engine] of watchSyncs) result[fp] = engine.getStatus();
  return result;
});

// ── LAN P2P IPC ────────────────────────────────────────────────────────────────
ipcMain.handle('lan:start', async () => {
  try {
    let username = os.userInfo().username || 'Desktop';
    try {
      // Try to get the logged-in Patrins display name from cookies
      const cookies = await mainWindow.webContents.session.cookies.get({ url: 'https://patrins.com' });
      const tok = cookies.find(c => c.name === 'token');
      if (tok) {
        // Fetch display name from the API
        const info = await new Promise((res, rej) => {
          const req = net.request({ method: 'GET', url: 'https://patrins.com/api/auth/me',
            session: mainWindow.webContents.session, useSessionCookies: true });
          let body = ''; req.on('response', r => { r.on('data', c => body += c); r.on('end', () => { try { res(JSON.parse(body)); } catch { rej(new Error('bad json')); } }); });
          req.on('error', rej); req.end();
        });
        if (info?.display_name) username = info.display_name;
        else if (info?.username) username = info.username;
      }
    } catch (_) {}

    const result = await lan.start(username, app.getPath('downloads'));
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.on('lan:stop', () => lan.stop());
ipcMain.handle('lan:peers', () => lan.getPeers());
ipcMain.handle('lan:status', () => ({
  running: lan._running,
  ip:      lan.localIP,
  port:    lan._httpPort,
  peers:   lan.getPeers(),
}));

ipcMain.handle('lan:send-file', async (_, { peerId, filePath }) => {
  if (!filePath) {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose File to Send via Local Network',
      properties: ['openFile'],
    });
    if (canceled) return { ok: false, cancelled: true };
    filePath = filePaths[0];
  }
  const result = await lan.sendFile(peerId, filePath);
  return result;
});

lan.on('send-progress', (data) => mainWindow?.webContents?.send('lan:send-progress', data));
lan.on('send-done',     (data) => mainWindow?.webContents?.send('lan:send-done', data));

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
    logger.log('download_error', { error: err.message, size: logger.sizeRange(fileSize) });
    event.sender.send('download-progress', { downloadId, phase: 'error', error: err.message });
    return { status: 'error', error: err.message };
  }
});
