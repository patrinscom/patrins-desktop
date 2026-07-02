const { app } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SYS32 = 'C:\\Windows\\System32';
const WIN_ENV = { ...process.env, PATH: `${process.env.PATH || ''};${SYS32};C:\\Windows` };

function runCmd(cmd) {
  return new Promise((res, rej) =>
    exec(cmd, { windowsHide: true, shell: true, env: WIN_ENV }, (err, out, stderr) =>
      err ? rej(new Error((stderr || out || err.message).trim())) : res(out.trim())
    )
  );
}

async function registerContextMenu() {
  if (process.platform !== 'win32') return;
  const CURRENT_VERSION = 1;
  const key = 'contextMenuVersion';

  // Check version stored in userData — skip if already registered at current version
  const versionFile = path.join(app.getPath('userData'), 'ctx-menu-version.txt');
  try {
    const saved = parseInt(fs.readFileSync(versionFile, 'utf8'), 10);
    if (saved === CURRENT_VERSION) return;
  } catch (_) {}

  const exe = app.isPackaged ? process.execPath : process.argv[0];
  // Escape backslashes for .reg file format (each \ → \\)
  const exeReg = exe.replace(/\\/g, '\\\\');

  const regContent = `Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\Patrins]
@="Upload to Patrins"
"Icon"="${exeReg},0"

[HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\Patrins\\command]
@="\\"${exeReg}\\" \\"patrins://upload?path=%1\\""

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\PatrinsWatch]
@="Watch with Patrins"
"Icon"="${exeReg},0"

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\PatrinsWatch\\command]
@="\\"${exeReg}\\" \\"patrins://watch?path=%1\\""

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\PatrinsUploadHere]
@="Upload files here (Patrins)"
"Icon"="${exeReg},0"

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\PatrinsUploadHere\\command]
@="\\"${exeReg}\\" \\"patrins://uploadhere?path=%V\\""

`;

  const tmpFile = path.join(os.tmpdir(), 'patrins-shell.reg');
  try {
    // Write UTF-16 LE with BOM — standard .reg file format
    const bom = Buffer.from([0xff, 0xfe]);
    const content = Buffer.from(regContent, 'utf16le');
    fs.writeFileSync(tmpFile, Buffer.concat([bom, content]));
    await runCmd(`reg import "${tmpFile}"`);
    fs.writeFileSync(versionFile, String(CURRENT_VERSION), 'utf8');
    console.log('[ContextMenu] Registered Shell extension v' + CURRENT_VERSION);
  } catch (err) {
    console.error('[ContextMenu] Registration failed:', err.message.split('\n')[0]);
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

async function unregisterContextMenu() {
  if (process.platform !== 'win32') return;
  const cmds = [
    'reg delete "HKCU\\Software\\Classes\\*\\shell\\Patrins" /f',
    'reg delete "HKCU\\Software\\Classes\\Directory\\shell\\PatrinsWatch" /f',
    'reg delete "HKCU\\Software\\Classes\\Directory\\Background\\shell\\PatrinsUploadHere" /f',
  ];
  for (const cmd of cmds) await runCmd(cmd).catch(() => {});
  const versionFile = path.join(app.getPath('userData'), 'ctx-menu-version.txt');
  fs.unlink(versionFile, () => {});
}

module.exports = { registerContextMenu, unregisterContextMenu };
