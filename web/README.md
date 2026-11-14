# Lipscribe web

| Page | |
|---|---|
| `/` | Scroll story that introduces the idea, ends with a link to the demo. Plan in `STORY-BRIEF.md` |
| `/demo` | Live demo. Webcam with everything but the mouth blurred, recording, transcript, speech, history |
| `/download` | Desktop app downloads |

## Run

Needs Node.js 20+. Build the model files once (setup in [`../ml/README.md`](../ml/README.md)):

```sh
cd ../ml && uv run python scripts/package_web.py && cd ../web
npm run dev
```

Open http://localhost:3000/demo in Chrome, Edge or Safari. Camera access only works on `localhost` or HTTPS. The server restarts on `server.mjs` changes. Refresh the browser after editing `public/`.

Locally the model loads from `/models/` (`../ml/exports/web`). The deployed site loads it from a public Cloudflare R2 bucket because the files (55 to 165 MB) are too big for Vercel. After rebuilding the model, run `CLOUDFLARE_API_TOKEN=... uv run scripts/upload_r2.py` in `../ml`. Both URLs are in `modelBaseUrl` in `public/js/config.js`.

## Test

```sh
npm install && npm test
```

The parity tests need fixtures from `../ml/scripts/dump_parity.py`.

## How it works

All in `public/js/`. The video never leaves the browser.

1. `camera.js` opens the webcam, video only.
2. `lipread/face-target.js` finds faces (MediaPipe BlazeFace) and follows the largest one until you click another.
3. `mouth-tracker.js` runs MediaPipe Face Landmarker and draws the mouth highlight. The video is blurred in CSS and a sharp copy is masked to an ellipse around the mouth.
4. `lipread/frame-recorder.js` stores a small grayscale window around the face plus eye, nose and mouth points per frame. No video file is made.
5. `transcriber.js` resamples to 25 fps, `lipread/align.js` cuts 88x88 mouth crops, and `lipread/engine.js` runs the model with ONNX Runtime Web. It uses the q4f16 model (182 MB) on WebGPU when the GPU supports fp16, else the q4 model (248 MB) on WebGPU or WASM. `lipread/decode.js` runs beam search. The Cache API keeps the model after the first download.
6. `speech.js` reads the result aloud and `storage.js` saves it to history in `localStorage`.

Hands-free mode is on by default. `lipread/speech-detector.js` watches how fast the mouth opening changes. It starts recording when the lips move, keeps the second before, and stops after about a second of stillness. Each sentence is transcribed while the next one records. Thresholds are under `handsFree` in `config.js`.

`lipread/` is a port of `../ml/lipscribe_ml/`, checked by `npm test`.

## Voices

| Voice | Model | Latency | Price |
|---|---|---|---|
| Your voice (clone) | `fish-audio/s2.1-pro` | 1.5 to 3.5 s | $15 / 1M chars |
| Natural (10 presets) | `heygen/heygen-voice-1-turbo` | 0.6 to 2.5 s | $4 / 1M chars |
| Browser | system `speechSynthesis` | instant, offline | free |

Natural and cloned voices go through `POST /api/tts` (`lib/tts.mjs`), which calls [OpenRouter's speech API](https://openrouter.ai/docs/guides/overview/multimodal/tts). Put `OPENROUTER_API_KEY` in the environment or `web/.env`. The key never reaches the browser.

To clone a voice, the user ticks a consent box and reads a 20-second script into the mic. There is no file upload, so the sample comes from the person at the keyboard. The 24 kHz WAV stays in `localStorage` and goes along with each request. The server stores nothing (`voice-clone.js`).

Play through picks the output device (Chrome and Edge, `setSinkId`) and Volume boosts it up to 4x. Route it into a virtual cable ([BlackHole](https://existential.audio/blackhole/) on macOS, [VB-CABLE](https://vb-audio.com/Cable/) on Windows) and pick the same cable as the mic in the call app. Browser voices can't be routed. The [desktop app](../desktop/README.md) has its own microphone.

### Environment

| Variable | Default | |
|---|---|---|
| `OPENROUTER_API_KEY` | | Required for natural and cloned voices |
| `TTS_MODEL_CLONE`, `TTS_MODEL_PRESET`, `TTS_PRESET_VOICES` | see table above | Override models and voices |
| `TTS_PER_IP_PER_10MIN` | 40 | Requests per IP |
| `TTS_PER_IP_DAILY_CHARS` | 20,000 | Characters per IP per day |
| `TTS_DAILY_CHAR_LIMIT` | 200,000 | Characters per day for everyone, about $3 |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`) | | Shared rate-limit counters across Vercel instances. Without Redis they live in memory (`lib/ratelimit.mjs`) |
| `TTS_PROXY_URL` | | Forward `/api/tts` to another Lipscribe server (the desktop app uses this) |
| `MODELS_DIR` | `../ml/exports/web` | Where `/models/` is served from |

Requests are capped at 600 characters.

## Server mode

Set `engine: 'server'` in `public/js/config.js` to record a video with `MediaRecorder` and POST it to `/transcribe` instead of running the model in the browser. By default `/transcribe` is a mock that returns a random phrase after a second.

To forward clips to a real model, start the server with its URL. No CORS setup needed, and the header pill switches from "Mock model" to "Live model".

```sh
TRANSCRIBE_URL=http://localhost:8000/transcribe npm run dev
```

Or set `transcribeUrl` in `config.js` to call the endpoint straight from the browser. That server must allow CORS from `http://localhost:3000`.

The endpoint takes `multipart/form-data` with the clip in `video` and returns:

```json
{ "text": "Can you hear me now?", "confidence": 0.91 }
```

`confidence` (0 to 1) is optional. `transcript` or `prediction` work in place of `text`. For errors, return a non-2xx status with `{ "error": "message shown to the user" }`.

## Files

| File | |
|---|---|
| `server.mjs` | Static server, `/models/`, mock `/transcribe`, proxy |
| `lib/tts.mjs` | `/api/tts`, OpenRouter speech, proxy mode |
| `lib/ratelimit.mjs` | Voice rate limits |
| `lib/env.mjs` | Loads `web/.env` |
| `public/index.html`, `css/story.css`, `js/story.js` | Story page (GSAP ScrollTrigger + Lenis from CDN) |
| `public/js/mouth.js` | Illustrated mouth on the story page |
| `public/demo.html`, `css/demo.css` | Demo page |
| `public/download.html` | Download page |
| `public/css/base.css` | Shared tokens, top bar, buttons, footer |
| `public/js/config.js` | Settings (`engine`, `modelBaseUrl`, `beamSize`, `handsFree`, ...) |
| `public/js/demo.js` | Demo UI state and wiring |
| `public/js/camera.js` | Webcam and recorder |
| `public/js/mouth-tracker.js` | Face landmarks and mouth overlay |
| `public/js/transcriber.js` | The one call to the model, browser or server |
| `public/js/lipread/engine.js` | ONNX Runtime Web setup, model download and cache, inference |
| `public/js/lipread/decode.js` | Beam search and greedy decoding (port of `decode.py`) |
| `public/js/lipread/align.js` | Mouth crops and 25 fps resampling (port of `preprocess.py`) |
| `public/js/lipread/face-target.js` | Face detection and click-to-choose tracking |
| `public/js/lipread/frame-recorder.js` | Face windows and keypoints instead of video |
| `public/js/lipread/speech-detector.js` | Hands-free lip-motion detection |
| `public/js/speech.js` | Browser, natural and cloned voices, output device |
| `public/js/voice-clone.js` | Records and stores the voice sample |
| `public/js/storage.js` | History and preferences in `localStorage` |
| `test/lipread.test.mjs` | Parity tests against the Python pipeline |
| `test/speech-detector.test.mjs` | Hands-free detector tests |
