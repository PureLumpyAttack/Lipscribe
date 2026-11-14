# Lipscribe desktop app

An Electron app that runs the Lipscribe demo page on your computer with the lip-reading model built in, so it works offline and needs no 182 MB download per browser. It adds what a browser tab can't do well:

- **Virtual microphone output.** Send the spoken words to a virtual audio cable ([BlackHole](https://existential.audio/blackhole/) on macOS, [VB-CABLE](https://vb-audio.com/Cable/) on Windows) and pick that cable as the microphone in Zoom, Meet, Teams or Discord. The cable driver has to be installed separately; an app can't add an audio device on its own.
- **Global shortcut** <kbd>⌘⇧L</kbd> / <kbd>Ctrl+Shift+L</kbd> starts and stops recording while the call app is in front.
- **Keep on top** (View menu) and no background throttling, so lip reading keeps running behind other windows.

The app starts the same `web/server.mjs` on a random local port and opens `/demo` in its own window. Camera and microphone stay on the computer.

## Voices

Natural and cloned voices need a Lipscribe server that holds the OpenRouter key. The app never ships a key: set `"ttsServer"` in `config.json` to that server (e.g. the production site, `https://...`) before building. Its `/api/tts` requests are forwarded there. For local testing you can instead run with `OPENROUTER_API_KEY=...` or `TTS_PROXY_URL=http://localhost:3000` in the environment. Without either, the app uses the system voices.

## Develop

Needs the browser model built first (`cd ../ml && uv run python scripts/package_web.py`).

```sh
npm install
npm start          # copies ../web and the q4f16 model into app/, then runs Electron
```

If `npm install` didn't download Electron (some sandboxes block `~/Library/Caches`), run `electron_config_cache=$PWD/.cache/electron node node_modules/electron/install.js`.

Self-check without a window: `LIPSCRIBE_SMOKE=1 npx electron .` prints WebGPU / model / voice status. Add `LIPSCRIBE_SMOKE_CLIPS=../ml/results/parity` to also transcribe the parity fixtures on the GPU.

## Build

Installers are built by GitHub Actions (`.github/workflows/desktop-release.yml`):

- **Push a tag** such as `v0.1.0`: builds macOS (Apple silicon and Intel) and Windows, then publishes a GitHub release with `Lipscribe-mac-arm64.dmg`, `Lipscribe-mac-x64.dmg` and `Lipscribe-win-x64.exe`. The website's `/download` page links straight to these files in the latest release.
- **Actions → Desktop release → Run workflow**: same builds, kept as workflow artifacts only. Tick "Rebuild the model" to rebuild it from the pretrained weights and upload it to R2 (needs the `CLOUDFLARE_R2_API_KEY` secret); otherwise the model is downloaded from R2.
- Set the repository variable `LIPSCRIBE_TTS_SERVER` to the website URL so the app's natural and cloned voices go through it.

Locally:

```sh
npm run dist:mac   # dist/Lipscribe-mac-arm64.dmg and Lipscribe-mac-x64.dmg (~270 MB each, unsigned)
npm run dist:win   # dist/Lipscribe-win-x64.exe (build on Windows, or a Mac with Wine)
```

Builds are unsigned: macOS users right-click → Open the first time; Windows users click More info → Run anyway.
