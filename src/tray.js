const { Tray, Menu, app, shell, nativeImage } = require('electron');
const path = require('path');
const logger = require('./logger');

let tray         = null;
let _mainWindow  = null;
let _syncState   = null;
let _driveLetter = null;
let _watchFolders = []; // [{path, state}]
let _callbacks   = {};

const DASHBOARD_URL = 'https://patrins.com/dashboard';

function buildMenu() {
  const items = [
    {
      label: 'Open Patrins',
      click: () => { _mainWindow.show(); _mainWindow.focus(); },
    },
    {
      label: 'Dashboard',
      click: () => { _mainWindow.loadURL(DASHBOARD_URL); _mainWindow.show(); _mainWindow.focus(); },
    },
    { type: 'separator' },
    {
      label: 'Quick Upload…',
      click: () => { if (_callbacks.showDropWindow) _callbacks.showDropWindow(); },
    },
  ];

  if (_driveLetter) {
    items.push({
      label: `Open Drive (${_driveLetter}:)`,
      click: () => shell.openPath(`${_driveLetter}:\\`),
    });
  }

  if (_syncState && _syncState !== 'stopped') {
    const label = {
      'up-to-date': 'Sync: Up to date',
      syncing:      'Sync: Syncing…',
      paused:       'Sync: Paused',
      error:        'Sync: Error',
    }[_syncState] || `Sync: ${_syncState}`;

    items.push({ label, enabled: false });

    if (_syncState === 'paused') {
      items.push({ label: 'Resume Sync', click: () => app.emit('sync:resume-from-tray') });
    } else if (_syncState !== 'error') {
      items.push({ label: 'Pause Sync', click: () => app.emit('sync:pause-from-tray') });
    }
  }

  // Watch folders section
  if (_watchFolders.length > 0) {
    items.push({ type: 'separator' });
    items.push({ label: 'Watch Folders', enabled: false });
    for (const wf of _watchFolders) {
      const icon = wf.state === 'syncing' ? '⟳' : wf.state === 'error' ? '✕' : '✓';
      items.push({
        label:   `  ${icon} ${path.basename(wf.path)}`,
        enabled: true,
        click:   () => shell.openPath(wf.path),
      });
    }
  }

  items.push(
    { type: 'separator' },
    {
      label:   'Send Diagnostics',
      type:    'checkbox',
      checked: logger.isEnabled(),
      click:   (item) => logger.setEnabled(item.checked),
    },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  );

  return Menu.buildFromTemplate(items);
}

function createTray(mainWindow, callbacks = {}) {
  _mainWindow = mainWindow;
  _callbacks  = callbacks;
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/icon.ico'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Patrins');
  tray.setContextMenu(buildMenu());

  tray.on('click', () => {
    if (_mainWindow.isVisible()) _mainWindow.focus();
    else { _mainWindow.show(); _mainWindow.focus(); }
  });

  return tray;
}

function updateTrayMenu(syncState, driveLetter, watchFolders) {
  if (!tray) return;
  if (syncState    !== undefined) _syncState    = syncState;
  if (driveLetter  !== undefined) _driveLetter  = driveLetter;
  if (watchFolders !== undefined) _watchFolders = watchFolders;
  tray.setContextMenu(buildMenu());
}

module.exports = { createTray, updateTrayMenu };
