# Lipscribe desktop

Electron app that runs the `/demo` page with the model built in. Works offline, no 182 MB download per browser.

What it adds over the browser:

- A virtual microphone, so Zoom, Meet, Teams or Discord hear the spoken text.
- Volume boost up to 4x, with a limiter.
- Hands-free mode. Recording starts when your lips move and each sentence is sent when you pause.
- Global shortcut <kbd>⌘⇧L</kbd> / <kbd>Ctrl+Shift+L</kbd> to start and stop recording from inside the call app.
- Keep on top (View menu). No background throttling.

The app starts `web/server.mjs` on a random local port and opens `/demo` in its own window.

## Virtual microphone

On macOS, click "Add Lipscribe Microphone" and enter the admin password once. The driver goes to `/Library/Audio/Plug-Ins/HAL` and Core Audio restarts. Pick "Lipscribe Microphone" in the call app. It never becomes the system default. Remove it from Help → Remove Lipscribe Microphone.

The driver is [BlackHole](https://github.com/ExistentialAudio/BlackHole) v0.7.1 (GPL-3.0) built under our name by `scripts/build-mic-driver.sh`. It needs only `xcode-select --install`. The license and source link ship inside the bundle.

Windows needs a Microsoft-signed driver for new audio devices, so use [VB-CABLE](https://vb-audio.com/Cable/). Set Play through to CABLE Input and pick CABLE Output in the call app.

## Voices

Natural and cloned voices need a Lipscribe server that holds the OpenRouter key. The app never ships a key. Set `"ttsServer"` in `config.json` before building and `/api/tts` requests go there.

For local testing, set `OPENROUTER_API_KEY=...` or `TTS_PROXY_URL=http://localhost:3000` instead. With neither, the app uses system voices.

## Develop

Build the browser model first (`cd ../ml && uv run python scripts/package_web.py`).

```sh
npm install
npm start          # copies ../web and the q4f16 model into app/, then runs Electron
```

If `npm install` skipped Electron (some sandboxes block `~/Library/Caches`):

```sh
electron_config_cache=$PWD/.cache/electron node node_modules/electron/install.js
```

Headless self-check, prints WebGPU, model and voice status:

```sh
LIPSCRIBE_SMOKE=1 npx electron .
LIPSCRIBE_SMOKE_CLIPS=../ml/results/parity LIPSCRIBE_SMOKE=1 npx electron .   # also transcribes the parity clips
```

## Release

GitHub Actions builds installers (`.github/workflows/desktop-release.yml`).

- Push a tag like `v0.1.0`. CI builds macOS (arm64, x64) and Windows and publishes a release with `Lipscribe-mac-arm64.dmg`, `Lipscribe-mac-x64.dmg` and `Lipscribe-win-x64.exe`. The site's `/download` page links to the latest release.
- Actions → Desktop release → Run workflow does the same builds as workflow artifacts only. "Rebuild the model" rebuilds it from the pretrained weights and uploads it to R2 (needs the `CLOUDFLARE_R2_API_KEY` secret). Otherwise CI downloads it from R2.
- Set the repository variable `LIPSCRIBE_TTS_SERVER` to the website URL for natural and cloned voices.

Local builds:

```sh
npm run dist:mac   # dist/Lipscribe-mac-{arm64,x64}.dmg, ~270 MB each
npm run dist:win   # dist/Lipscribe-win-x64.exe (Windows, or a Mac with Wine)
```

## Unsigned builds

We have no Apple or Microsoft developer signature. `scripts/after-pack.cjs` ad-hoc signs the macOS app, so macOS shows "unverified developer" instead of "damaged". Open it once, then System Settings → Privacy & Security → Open Anyway.

Version 0.1.0 still says "damaged". Fix it with `xattr -cr /Applications/Lipscribe.app`.

On Windows, click More info → Run anyway.
