// Lipscribe desktop app.
//
// Runs the same page as the website, served from a local server inside the
// app with the lip-reading model bundled (no 182 MB download, works offline).
// Spoken output can go to any audio device, including a virtual microphone
// (BlackHole on macOS, VB-CABLE on Windows) that Zoom, Meet or Discord use as
// their mic. A global shortcut starts/stops recording while another app has focus.
//
// Natural and cloned voices need a Lipscribe server with an OpenRouter key:
// set "ttsServer" in config.json (e.g. the production site) before building,
// or run with OPENROUTER_API_KEY / TTS_PROXY_URL in the environment.

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, session, shell, systemPreferences } from 'electron';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const resources = app.isPackaged ? process.resourcesPath : join(here, 'app');
const settings = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
const SHORTCUT = 'CommandOrControl+Shift+L';
const SMOKE = process.env.LIPSCRIBE_SMOKE === '1'; // headless self-check: load the page, print checks, quit

if (!process.env.OPENROUTER_API_KEY && !process.env.TTS_PROXY_URL && settings.ttsServer) {
  process.env.TTS_PROXY_URL = settings.ttsServer;
}

let win = null;
let origin = '';

/* ---------- Lipscribe Microphone (macOS virtual audio device) ----------
 * A renamed BlackHole driver (scripts/build-mic-driver.sh) shipped inside the
 * app. Installing it copies it into /Library/Audio/Plug-Ins/HAL (asks for the
 * admin password once) and restarts Core Audio so the device appears. Lipscribe
 * plays the voice into it; call apps pick it as their microphone. */

const MIC_BUNDLE = 'LipscribeMicrophone.driver';
const MIC_DEST = `/Library/Audio/Plug-Ins/HAL/${MIC_BUNDLE}`;
const micSource = () => join(resources, 'drivers', MIC_BUNDLE);

function bundleVersion(dir) {
  try {
    const plist = readFileSync(join(dir, 'Contents', 'Info.plist'), 'utf8');
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

function micStatus() {
  if (process.platform !== 'darwin') return { supported: false };
  const bundled = bundleVersion(micSource());
  const installed = bundleVersion(MIC_DEST);
  return { supported: Boolean(bundled), installed: Boolean(installed), outdated: Boolean(installed && bundled && installed !== bundled) };
}

const shQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const appleScriptString = (s) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** Run a shell command as root via the standard macOS password prompt. */
function runAsAdmin(command, prompt) {
  const script = `do shell script ${appleScriptString(command)} with prompt ${appleScriptString(prompt)} with administrator privileges`;
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], (error, _stdout, stderr) => {
      if (!error) return resolve({ ok: true });
      const cancelled = /-128|User canceled/i.test(stderr);
      resolve({ ok: false, cancelled, error: cancelled ? '' : stderr.trim() || error.message });
    });
  });
}

// Core Audio restarts on its own after the kill; the device shows up a second later.
const RESTART_AUDIO = '(killall coreaudiod 2>/dev/null || launchctl kickstart -k system/com.apple.audio.coreaudiod || true)';

async function installMic() {
  const status = micStatus();
  if (!status.supported) return { ok: false, error: 'The Lipscribe Microphone is only available in the macOS app.' };
  const src = micSource();
  const result = await runAsAdmin(
    [
      'mkdir -p /Library/Audio/Plug-Ins/HAL',
      `rm -rf ${shQuote(MIC_DEST)}`,
      `cp -R ${shQuote(src)} ${shQuote(MIC_DEST)}`,
      `xattr -cr ${shQuote(MIC_DEST)}`, // drop the download quarantine flag inherited from the app
      `chown -R root:wheel ${shQuote(MIC_DEST)}`,
      RESTART_AUDIO,
    ].join(' && '),
    'Lipscribe wants to add the Lipscribe Microphone, so call apps can hear its voice.',
  );
  return { ...result, ...micStatus() };
}

async function uninstallMic() {
  const result = await runAsAdmin(`rm -rf ${shQuote(MIC_DEST)} && ${RESTART_AUDIO}`, 'Lipscribe wants to remove the Lipscribe Microphone.');
  buildMenu();
  return { ...result, ...micStatus() };
}

const fromOurPage = (event) => Boolean(origin) && event.senderFrame?.url.startsWith(origin);
ipcMain.handle('mic:status', (event) => (fromOurPage(event) ? micStatus() : null));
ipcMain.handle('mic:install', async (event) => {
  if (!fromOurPage(event)) return null;
  const result = await installMic();
  buildMenu();
  return result;
});

async function createWindow() {
  const { startServer } = await import(pathToFileURL(join(resources, 'web', 'server.mjs')).href);
  const { port } = await startServer({
    port: 0,
    host: '127.0.0.1',
    public: join(resources, 'web', 'public'),
    models: join(resources, 'models'),
    quiet: app.isPackaged,
  });
  origin = `http://127.0.0.1:${port}`;

  // Camera for lip reading, microphone for recording a voice sample,
  // speaker-selection for sending speech to a virtual microphone.
  const allowed = new Set(['media', 'speaker-selection', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(allowed.has(permission) && wc.getURL().startsWith(origin));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
    return allowed.has(permission) && requestingOrigin.startsWith(origin);
  });
  if (process.platform === 'darwin' && !SMOKE) {
    await systemPreferences.askForMediaAccess('camera').catch(() => false);
  }

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    title: 'Lipscribe',
    icon: join(here, 'build', 'icon.png'), // Windows/Linux taskbar (ignored on macOS)
    show: !SMOKE,
    backgroundColor: '#fbfbfa',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // keep reading lips while the window is behind a call app
    },
  });
  // Links to other sites (BlackHole, VB-CABLE, GitHub) open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  await win.loadURL(`${origin}/demo`);
  if (SMOKE) await smokeTest();
}

async function smokeTest() {
  const result = await win.webContents.executeJavaScript(`(async () => {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    const manifest = await (await fetch('/models/manifest.json')).json();
    const status = await (await fetch('/api/status')).json();
    const voices = await (await fetch('/api/tts/voices')).json();
    const head = await fetch('/models/q4f16/encoder.onnx', { method: 'HEAD' });
    return {
      title: document.title,
      webgpu: Boolean(adapter),
      shaderF16: Boolean(adapter?.features.has('shader-f16')),
      setSinkId: 'setSinkId' in HTMLMediaElement.prototype,
      bridge: Boolean(window.lipscribeApp?.isDesktop),
      models: Object.keys(manifest.variants),
      encoderBytes: Number(head.headers.get('content-length')),
      status,
      voices: { enabled: voices.enabled, presets: voices.presets?.length ?? 0 },
      mic: await window.lipscribeApp?.mic?.status(),
    };
  })()`);
  console.log('SMOKE ' + JSON.stringify(result));

  // Optional: run the model on crop fixtures (ml/scripts/dump_parity.py) with WebGPU.
  // LIPSCRIBE_SMOKE_CLIPS=/path/to/ml/results/parity
  const dir = process.env.LIPSCRIBE_SMOKE_CLIPS;
  if (dir) {
    const clips = JSON.parse(readFileSync(join(dir, 'decode.json'), 'utf8')).slice(0, Number(process.env.LIPSCRIBE_SMOKE_N || 8));
    for (const clip of clips) {
      const b64 = readFileSync(join(dir, 'decode', `${clip.id}.bin`)).toString('base64');
      const out = await win.webContents.executeJavaScript(`(async () => {
        const { getEngine } = await import('/js/transcriber.js');
        const engine = getEngine();
        await engine.load();
        const bin = Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0));
        const r = await engine.transcribe(bin, ${clip.T});
        return { text: r.text, ms: Math.round(r.ms), backend: engine.info.label };
      })()`);
      console.log(`CLIP ${clip.id} ${out.ms}ms [${out.backend}] ${out.text === clip.python ? '=' : '≠'} ${out.text} | python(q4): ${clip.python}`);
    }
  }
  app.exit(0);
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Keep on top',
          type: 'checkbox',
          click: (item) => win?.setAlwaysOnTop(item.checked, 'floating'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'BlackHole (virtual mic for macOS)', click: () => shell.openExternal('https://existential.audio/blackhole/') },
        { label: 'VB-CABLE (virtual mic for Windows)', click: () => shell.openExternal('https://vb-audio.com/Cable/') },
        { label: 'Lipscribe on GitHub', click: () => shell.openExternal('https://github.com/PureLumpyAttack/Lipscribe') },
        ...(micStatus().installed ? [{ type: 'separator' }, { label: 'Remove Lipscribe Microphone…', click: () => uninstallMic() }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // The packaged app gets its icon from the bundle; set it for `npm start` too.
  const icon = nativeImage.createFromPath(join(here, 'build', 'icon.png'));
  if (!app.isPackaged && !icon.isEmpty()) app.dock?.setIcon(icon);
  buildMenu();
  await createWindow();
  // Start/stop recording from anywhere, e.g. while the call app is in front.
  globalShortcut.register(SHORTCUT, () => win?.webContents.send('lipscribe:toggle-recording'));
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
