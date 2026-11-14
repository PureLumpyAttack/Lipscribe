// Localhost server for the Lipscribe web app.
//
//   GET  /*            static files from ./public
//   GET  /models/*     browser model files from ../ml/exports/web (ml/scripts/package_web.py),
//                      or from MODELS_DIR if set
//   GET  /api/status   { mode: 'mock' | 'proxy', tts: bool }
//   GET  /api/tts/voices, POST /api/tts   natural / cloned voices (lib/tts.mjs)
//   POST /transcribe   multipart video in, { text, confidence } out
//
// /transcribe returns fake text unless TRANSCRIBE_URL is set, in which case
// the request is forwarded untouched to the real model (no CORS setup needed).
//
// Settings come from the environment or web/.env (OPENROUTER_API_KEY, PORT,
// HOST, MODELS_DIR, TRANSCRIBE_URL, TTS_*). The desktop app imports
// startServer() instead of running this file; Vercel imports the default
// export (the request handler).

import './lib/env.mjs';
import { handleTts, ttsStatus } from './lib/tts.mjs';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const modelUrl = process.env.TRANSCRIBE_URL || '';
let publicDir = fileURLToPath(new URL('./public/', import.meta.url));
let modelsDir = resolve(process.env.MODELS_DIR || fileURLToPath(new URL('../ml/exports/web/', import.meta.url))) + '/';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

const MOCK_PHRASES = [
  'Can you hear me now?',
  "I'll call you back in five minutes.",
  'Could you turn the music down, please?',
  'Nice to meet you, thanks for stopping by.',
  'I need a glass of water.',
  "Let's meet at the front entrance.",
  'Where is the nearest exit?',
  'Sorry, it is really loud in here.',
  'Can we move somewhere quieter?',
  'Thank you so much for your help.',
];

// Vercel (and other hosts that import this file) call the default export per request.
export default async function handle(request, response) {
  const { pathname } = new URL(request.url, 'http://localhost');
  try {
    if (await handleTts(pathname, request, response)) return;
    if (pathname === '/transcribe' && request.method === 'POST') {
      return modelUrl ? await proxyTranscribe(request, response) : await mockTranscribe(request, response);
    }
    if (pathname === '/api/status' && request.method === 'GET') {
      return sendJson(response, 200, { mode: modelUrl ? 'proxy' : 'mock', tts: ttsStatus() });
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && pathname.startsWith('/models/')) {
      return await serveModel(pathname, request, response);
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      return await serveStatic(pathname, request, response);
    }
    sendJson(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: 'Server error' });
    else response.end();
  }
}

/**
 * Start the server. Options override the environment (used by the desktop app).
 * Resolves with the bound port (pass port 0 for any free port).
 */
export function startServer({ port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1', public: pub, models, quiet = false } = {}) {
  if (pub) publicDir = resolve(pub) + '/';
  if (models) modelsDir = resolve(models) + '/';
  return new Promise((done, fail) => {
    const server = createServer(handle);
    server.on('error', fail);
    server.listen(port, host, () => {
      const bound = server.address().port;
      if (!quiet) {
        console.log(`Lipscribe is running at http://localhost:${bound}`);
        console.log(modelUrl ? `/transcribe → ${modelUrl}` : '/transcribe → mock responses');
        console.log(ttsStatus() ? 'natural voices → OpenRouter' : 'natural voices off (set OPENROUTER_API_KEY in web/.env)');
      }
      done({ server, port: bound });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer();
}

async function mockTranscribe(request, response) {
  let bytes = 0;
  for await (const chunk of request) bytes += chunk.length;
  if (bytes === 0) return sendJson(response, 400, { error: 'No video received.' });

  await new Promise((done) => setTimeout(done, 700 + Math.random() * 900));
  const text = MOCK_PHRASES[Math.floor(Math.random() * MOCK_PHRASES.length)];
  console.log(`[mock] ${Math.round(bytes / 1024)} KB clip → "${text}"`);
  sendJson(response, 200, { text, confidence: Number((0.78 + Math.random() * 0.2).toFixed(2)), model: 'mock' });
}

async function proxyTranscribe(request, response) {
  let upstream;
  try {
    upstream = await fetch(modelUrl, {
      method: 'POST',
      headers: { 'content-type': request.headers['content-type'] ?? 'application/octet-stream' },
      body: request,
      duplex: 'half',
    });
  } catch (error) {
    console.error(`[proxy] ${modelUrl} unreachable: ${error.message}`);
    return sendJson(response, 502, { error: "Couldn't reach the lip-reading model." });
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
  });
  response.end(body);
}

async function serveStatic(pathname, request, response) {
  let relative;
  try {
    relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return sendText(response, 400, 'Bad request');
  }
  // Clean URLs: /demo serves demo.html.
  const file = resolve(publicDir, extname(relative) ? relative : `${relative}.html`);
  if (!file.startsWith(publicDir)) return sendText(response, 404, 'Not found');

  let content;
  try {
    content = await readFile(file);
  } catch {
    return sendText(response, 404, 'Not found');
  }
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  response.end(request.method === 'HEAD' ? undefined : content);
}

// Model files are large (100+ MB), so stream them. The page keeps its own copy
// in the Cache API keyed by manifest version, so no HTTP caching is needed.
async function serveModel(pathname, request, response) {
  let file;
  try {
    file = resolve(modelsDir, decodeURIComponent(pathname.slice('/models/'.length)));
  } catch {
    return sendText(response, 400, 'Bad request');
  }
  if (!file.startsWith(modelsDir)) return sendText(response, 404, 'Not found');
  let info;
  try {
    info = await stat(file);
  } catch {
    return sendJson(response, 404, { error: 'Model file not found. Build it with: cd ml && uv run python scripts/package_web.py' });
  }
  if (!info.isFile()) return sendText(response, 404, 'Not found');
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
  });
  if (request.method === 'HEAD') return response.end();
  createReadStream(file).pipe(response);
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function sendText(response, status, text) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(text);
}
