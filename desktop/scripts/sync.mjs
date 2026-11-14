// Copy the website and the browser model into desktop/app/ for the app to serve.
//   ../web/{server.mjs,lib,public}         -> app/web/
//   ../ml/exports/web (q4f16 model only)   -> app/models/
//   .cache/drivers (macOS only)            -> app/drivers/  (Lipscribe Microphone,
//                                             built by scripts/build-mic-driver.sh)
// Build the model first: cd ../ml && uv run python scripts/package_web.py

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const web = here('../../web/');
const models = here('../../ml/exports/web/');
const out = here('../app/');

if (!existsSync(`${models}manifest.json`)) {
  console.error('Model files not found. Run: cd ../ml && uv run python scripts/package_web.py');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}web`, { recursive: true });
for (const item of ['server.mjs', 'lib', 'public']) cpSync(`${web}${item}`, `${out}web/${item}`, { recursive: true });

// The desktop app ships only the q4f16 model (182 MB): every GPU that runs
// Electron's WebGPU with shader-f16 uses it; others fall back to it on WASM.
const VARIANT = 'q4f16';
mkdirSync(`${out}models`, { recursive: true });
cpSync(`${models}${VARIANT}`, `${out}models/${VARIANT}`, { recursive: true });
for (const f of ['tokens.json', 'preprocess.json']) cpSync(`${models}${f}`, `${out}models/${f}`);
const manifest = JSON.parse(readFileSync(`${models}manifest.json`, 'utf8'));
manifest.variants = { [VARIANT]: manifest.variants[VARIANT] };
writeFileSync(`${out}models/manifest.json`, JSON.stringify(manifest, null, 1));

// macOS: the virtual microphone driver. Built on first use (needs clang from
// the Xcode command line tools); the app works without it.
if (process.platform === 'darwin') {
  const driver = here('../.cache/drivers/LipscribeMicrophone.driver');
  if (!existsSync(driver)) {
    try {
      execFileSync('bash', [here('build-mic-driver.sh')], { stdio: 'inherit' });
    } catch {
      console.warn('Could not build the Lipscribe Microphone driver (needs: xcode-select --install). Continuing without it.');
    }
  }
  if (existsSync(driver)) cpSync(driver, `${out}drivers/LipscribeMicrophone.driver`, { recursive: true, verbatimSymlinks: true });
}
console.log(`synced web + ${VARIANT} model${existsSync(`${out}drivers`) ? ' + Lipscribe Microphone' : ''} into ${out}`);
