# Kinetic

A desktop launcher for recompiled and ported games. Imports from Azimuth, Steam, Epic and GOG, tracks play time, and updates itself.

## Run from source

```
npm install
npm start
```

## Build the exe

```
npm run pack
```

Produces `dist/Kinetic-win32-x64/Kinetic.exe`. Your library and settings live in `%APPDATA%\game-launcher`, outside the exe folder, so rebuilding never touches them.

To use a portable Azimuth, put it in an `azimuth` folder next to `Kinetic.exe` (`azimuth.exe` plus its `data` folder).

## Release an update

1. Raise `version` in `package.json`.
2. `npm run release` builds the exe and writes `app.asar` and `app.asar.sha256` to `dist/release/`.
3. Publish both files on a GitHub release tagged `v<version>` (the script prints the `gh` command).
4. In the launcher, Settings → Updates takes the repo as `owner/name`.

## Layout

| Path | What it is |
|---|---|
| `main.js` | main process: library, launching, imports, Discord, updates |
| `preload.js` | the bridge between the UI and the main process |
| `importers.js` | Steam / Epic / GOG scanners |
| `updater.js` | update check, download, checksum and swap |
| `renderer/` | the UI (`theme.css` holds the colours and fonts) |
| `scripts/` | `pack.js` and `release.js` |
