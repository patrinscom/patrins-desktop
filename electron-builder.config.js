module.exports = {
  appId: 'com.patrins.desktop',
  productName: 'Patrins',
  copyright: 'Copyright © 2026 Patrins',

  directories: {
    output: 'dist'
  },

  files: [
    'src/**/*',
    'build/icon.ico',
    'build/icon.icns',
    'package.json'
  ],

  mac: {
    target: [{ target: 'dmg', arch: ['universal'] }],
    icon: 'build/icon.icns',
    category: 'public.app-category.productivity',
    identity: null,
  },

  // Ad-hoc sign the .app before DMG creation so Gatekeeper shows "Open Anyway"
  // instead of a hard "cannot be verified" block with no escape hatch.
  afterPack: async (ctx) => {
    if (ctx.electronPlatformName !== 'darwin') return;
    const { execSync } = require('child_process');
    const app = `${ctx.appOutDir}/Patrins.app`;
    execSync(`codesign --force --deep --sign - "${app}"`, { stdio: 'inherit' });
  },

  dmg: {
    title: 'Patrins ${version}',
    background: null,
    window: { width: 540, height: 380 },
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    requestedExecutionLevel: 'asInvoker',
    signAndEditExecutable: false,
    forceCodeSigning: false
  },

  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    deleteAppDataOnUninstall: true,
    include: 'build/uninstaller.nsh',
    runAfterFinish: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Patrins'
  },

  publish: {
    provider: 'generic',
    url: 'https://patrins.com/updates/'
  }
};
