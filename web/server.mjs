// Localhost server for the Lipscribe web app.
//
//   GET  /*            static files from ./public
//   GET  /api/status   { mode: 'mock' | 'proxy' }
//   POST /transcribe   multipart video in, { text, confidence } out
//
// /transcribe returns fake text unless TRANSCRIBE_URL is set, in which case
// the request is forwarded untouched to the real model (no CORS setup needed).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 3000);
const modelUrl = process.env.TRANSCRIBE_URL || '';
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));

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

createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  try {
    if (pathname === '/transcribe' && request.method === 'POST') {
      return modelUrl ? await proxyTranscribe(request, response) : await mockTranscribe(request, response);
    }
    if (pathname === '/api/status' && request.method === 'GET') {
      return sendJson(response, 200, { mode: modelUrl ? 'proxy' : 'mock' });
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
}).listen(port, '127.0.0.1', () => {
  console.log(`Lipscribe is running at http://localhost:${port}`);
  console.log(modelUrl ? `/transcribe → ${modelUrl}` : '/transcribe → mock responses');
});

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
  const file = resolve(publicDir, relative);
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

function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function sendText(response, status, text) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(text);
}
