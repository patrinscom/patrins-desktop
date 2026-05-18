const { Tray, Menu, app, nativeImage } = require('electron');
const path = require('path');

let tray = null;

function createTray(mainWindow) {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/icon.ico'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  tray.setToolTip('Patrins');

  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open Patrins',
      click: () => { mainWindow.show(); mainWindow.focus(); }
    },
    {
      label: 'Dashboard',
      click: () => {
        mainWindow.loadURL('https://patrins.com/dashboard');
        mainWindow.show();
        mainWindow.focus();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { app.isQuitting = true; app.quit(); }
    }
  ]));

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return tray;
}

module.exports = { createTray };
