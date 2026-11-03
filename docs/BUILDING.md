# Building and releasing

## Local build

Build Windows x64 artifacts on Windows x64 with Node.js 24.18.0 and npm. Versions are pinned in `package.json` and `package-lock.json`.

```powershell
npm ci
npm test
npm run check
npm run format:check
npm run release:build
npm run release:verify
```

`npm ci` downloads the development Electron binary and applies the compatibility changes in `scripts/apply-werift-compat.mjs`. That script accepts only the pinned upstream bundle or the reviewed patched bundle. The human-readable diff is in `patches/werift-0.25.2.diff`. Do not upgrade werift without reviewing and testing those changes.

`npm run desktop:build` builds an unpacked app for local inspection. `npm run release:build` also builds an assisted NSIS installer and a portable ZIP using [electron-builder](https://www.electron.build/docs/nsis/). No command publishes a release.

Expected files:

```text
dist/
  PartyBridge-Setup-0.1.0-x64.exe
  PartyBridge-0.1.0-x64.zip
  SHA256SUMS.txt
  win-unpacked/
```

The helper uses a bundled stock Node runtime so it is independent of Electron's ABI and a user's system Node installation. The Node version, SHA-256 hash and license ship in `resources/node`. Only production npm dependencies enter the application bundle.

The current installer is unsigned. A future signed release needs a publisher-owned signing identity and a separate reviewed signing setup. No signing credentials are stored in this repository.

## Source, development and release profiles

Keep this repository separate from private research and local experiments. Do not copy an entire existing workspace over it. Copy reviewed source changes, then run the tests and release checks again.

The release uses `%APPDATA%\PartyBridge Release`; `npm start` uses `%APPDATA%\PartyBridge Release Dev`. Neither reads the original local app's saved login. Ports are assigned dynamically and each desktop process owns its helper. Keep release and development shortcuts pointed to their corresponding EXEs.

## GitHub preparation

The source folder is ready to become a new repository. Review its files, set your Git author identity, and commit the source when ready. Never add `dist`, `node_modules`, local logs, `.local`, app-data folders, tokens or extracted application packages.

CI runs offline tests, syntax checks, formatting and release-source verification. The **Build Windows release** workflow runs manually or after a version tag is pushed. It uploads build artifacts to that workflow run with read-only repository permissions; it does not create or publish a GitHub Release.

When you decide to publish:

1. Update the package version, lockfile and changelog together.
2. Run the checks and build, or use the Windows build workflow.
3. Test installation, opening, sign-in, quit, upgrade and uninstall on a clean Windows account or VM. Offline tests do not establish live Sony service compatibility.
4. Confirm party voice in both directions and participant leave/rejoin behavior.
5. Review source and artifact contents for private data.
6. Create a GitHub Release for the matching version and upload only the installer, portable ZIP and `SHA256SUMS.txt`.

Do not upload the unpacked app directory as source, and do not reuse a personal login profile as test data.

After reviewing and staging source with `git add .`, `npm run release:source` creates a source ZIP from the Git index and updates the checksums. It does not create a commit, add a remote, or publish anything.
