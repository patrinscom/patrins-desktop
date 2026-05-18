# Patrins Desktop

The official Windows desktop app for [Patrins](https://patrins.com) — a private file hosting platform.

## Features

- **Full dashboard access** — browse, upload, and manage your files without a browser
- **WebDAV drive** — mounts your Patrins storage as a Windows drive letter (P:) in File Explorer automatically on login
- **Background folder sync** — pick a local folder and keep it in sync with your Patrins account
- **Fast parallel downloads** — 8-thread segmented downloader (4 MB chunks, auto-retry)
- **Auto-updates** — silent background updates, installs on next quit
- **System tray** — runs in the background, minimize to tray on close
- **Deep link support** — `patrins://` protocol for auth callbacks and direct file downloads

## Requirements

- Windows 10 or 11 (x64)
- A [Patrins](https://patrins.com) account

## Installation

Download the latest installer from [patrins.com/downloads](https://patrins.com/downloads) or from the [Releases](https://github.com/patrinscom/patrins-desktop/releases) page and run it.

## Building from Source

### Prerequisites

- [Node.js](https://nodejs.org) 18+
- [Git](https://git-scm.com)

### Steps

```bash
git clone https://github.com/patrinscom/patrins-desktop.git
cd patrins-desktop
npm install --ignore-optional
```

**Run in development:**
```bash
npm start
```

**Build installer:**
```bash
npm run build:win
```

The installer will be output to `dist/`.

## Project Structure

```
src/
  main.js          # Main process — window, WebDAV mount, download engine, IPC
  sync.js          # Background folder sync engine (chokidar + Patrins API)
  tray.js          # System tray icon and menu
  preload.js       # Context bridge — exposes safe APIs to the renderer
  offline.html     # Shown when connection fails
  waiting-login.html # Shown while waiting for Google OAuth to complete
assets/
  icon.svg / .ico / .png
scripts/
  generate-icons.js  # Builds icon assets from SVG
electron-builder.config.js
```

## How WebDAV Works

On login, the app fetches a short-lived token from `patrins.com/api/dav/token` and mounts your drive using `net use` over HTTPS WebDAV. It configures the Windows WebClient service automatically (raises the file size limit from 50 MB to 4 GB, increases concurrent connections). No credentials are stored on disk — the token expires and rotates each session.

## How Sync Works

The sync engine watches a local folder using [chokidar](https://github.com/paulmillr/chokidar) and mirrors changes to a `Desktop Sync` folder on your Patrins account. It tracks file state (ID, mtime, size) locally in `%APPDATA%\Patrins\sync-state.json`. On upload it deletes the old version first to avoid duplicates.

## License

MIT — see [LICENSE](LICENSE)

## Links

- Website: [patrins.com](https://patrins.com)
- Support: [support@patrins.com](mailto:support@patrins.com)
