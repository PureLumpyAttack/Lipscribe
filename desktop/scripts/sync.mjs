// Copy the website and the browser model into desktop/app/ for the app to serve.
//   ../web/{server.mjs,lib,public}         -> app/web/
//   ../ml/exports/web (q4f16 model only)   -> app/models/
// Build the model first: cd ../ml && uv run python scripts/package_web.py

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
console.log(`synced web + ${VARIANT} model into ${out}`);
