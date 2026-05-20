const { Tray, Menu, app, shell, nativeImage } = require('electron');
const path = require('path');

let tray = null;
let _mainWindow = null;
let _syncState = null;
let _driveLetter = null;

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

  items.push(
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  );

  return Menu.buildFromTemplate(items);
}

function createTray(mainWindow) {
  _mainWindow = mainWindow;
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

function updateTrayMenu(syncState, driveLetter) {
  if (!tray) return;
  if (syncState    !== undefined) _syncState    = syncState;
  if (driveLetter  !== undefined) _driveLetter  = driveLetter;
  tray.setContextMenu(buildMenu());
}

module.exports = { createTray, updateTrayMenu };
