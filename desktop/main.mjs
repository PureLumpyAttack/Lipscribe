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

import { app, BrowserWindow, globalShortcut, Menu, session, shell, systemPreferences } from 'electron';
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

async function createWindow() {
  const { startServer } = await import(pathToFileURL(join(resources, 'web', 'server.mjs')).href);
  const { port } = await startServer({
    port: 0,
    host: '127.0.0.1',
    public: join(resources, 'web', 'public'),
    models: join(resources, 'models'),
    quiet: app.isPackaged,
  });
  const origin = `http://127.0.0.1:${port}`;

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
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu();
  await createWindow();
  // Start/stop recording from anywhere, e.g. while the call app is in front.
  globalShortcut.register(SHORTCUT, () => win?.webContents.send('lipscribe:toggle-recording'));
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
