# Lipscribe web

The Lipscribe website:

- `/`: the story, a full-screen scroll animation that introduces the problem and the idea, ending in buttons to the demo and the about page. The plan behind it is in `STORY-BRIEF.md`.
- `/about`: the product page explaining the project, with buttons into the demo.
- `/download`: the desktop app download page.
- `/demo`: the live demo. It shows a webcam view with everything except the mouth blurred, plus start/stop recording, transcription, text-to-speech playback and transcript history.

## Run

Requires Node.js 20 or newer. The demo runs the lip-reading model in the browser, so build the model files once (see `../ml/README.md` for setup):

```sh
cd ../ml && uv run python scripts/package_web.py && cd ../web
npm run dev
```

Open http://localhost:3000 in Chrome, Edge or Safari. The demo at http://localhost:3000/demo asks for the camera. Browsers only give camera access on `localhost` or HTTPS. The server restarts itself when `server.mjs` changes. Refresh the browser after editing anything in `public/`.

## How it works

1. `camera.js` opens the webcam (video only).
2. `lipread/face-target.js` finds every face (MediaPipe BlazeFace) and follows one person: the largest face until you click a face, then the person you clicked. With several people in view, their faces are outlined.
3. `mouth-tracker.js` loads MediaPipe Face Landmarker and highlights the chosen person's mouth. The highlight is done in CSS: the video is blurred, and a sharp copy is masked to a soft ellipse around the mouth. If the model can't load, a fixed outline shows where to put your mouth.
4. While recording, `lipread/frame-recorder.js` keeps a small grayscale window around the chosen face and its eye/nose/mouth points for every frame. No video file is made.
5. On stop, `transcriber.js` resamples to 25 fps, `lipread/align.js` cuts aligned 88x88 mouth crops, and `lipread/engine.js` runs the model with ONNX Runtime Web: WebGPU with the 4-bit/fp16 model (182 MB) when the GPU supports fp16, else the 4-bit model (248 MB) on WebGPU or WASM. `lipread/decode.js` turns the output into text with beam search. The model downloads once (progress in the header) and is kept in the browser's Cache API.
6. The result is shown, read aloud (`speech.js`, see Voices below), and saved to history in `localStorage` (`storage.js`).

`demo.js` connects these pieces. `config.js` holds the settings you can change (`engine`, `modelBaseUrl`, `beamSize`, ...). The video never leaves the browser.

The `lipread/` code is a port of `../ml/lipscribe_ml/` and is checked against it: `npm install && npm test` (needs fixtures from `../ml/scripts/dump_parity.py`).

## Voices

The Voice menu has three kinds of voices:

- **Your voice**: a clone of the user's own voice. "Use my voice" opens a dialog where they tick a consent box and read a short script (which starts with a consent sentence) into the microphone, about 20 seconds. Only live recording is offered, no file upload, so the sample is the person at the keyboard. The sample (24 kHz WAV) stays in the browser's `localStorage` and is sent with each request; OpenRouter voice cloning is stateless and the server stores nothing (`voice-clone.js`).
- **Natural voices**: 10 preset voices.
- **Browser voices**: the system's `speechSynthesis`, offline.

Natural and cloned voices go through `POST /api/tts` on this server (`lib/tts.mjs`), which calls [OpenRouter's speech API](https://openrouter.ai/docs/guides/overview/multimodal/tts) with `OPENROUTER_API_KEY` from the environment or `web/.env` (never sent to the browser):

| | Model | Latency | Price |
|---|---|---|---|
| Your voice | `fish-audio/s2.1-pro` (reference clip + transcript) | ~1.5–3.5 s | $15 / 1M characters |
| Natural voices | `heygen/heygen-voice-1-turbo` | ~0.6–2.5 s | $4 / 1M characters |

Override with `TTS_MODEL_CLONE`, `TTS_MODEL_PRESET`, `TTS_PRESET_VOICES`. Abuse limits for a public site: 600 characters per request, `TTS_PER_IP_PER_10MIN` (default 40) requests per IP, `TTS_DAILY_CHAR_LIMIT` (default 200,000 characters, about $3 a day) per server process. `TTS_PROXY_URL` forwards `/api/tts` to another Lipscribe server instead (used by the desktop app).

**Play through** picks the audio output for natural and cloned voices (Chrome and Edge, via `setSinkId`). Choose a virtual audio cable ([BlackHole](https://existential.audio/blackhole/) on macOS, [VB-CABLE](https://vb-audio.com/Cable/) on Windows) and select the same cable as the microphone in Zoom, Meet or Discord, so call participants hear Lipscribe. Browser voices can't be routed this way. The [desktop app](../desktop/) does the same with the model built in and a global shortcut.

## Server mode (optional)

Set `engine: 'server'` in `public/js/config.js` to record a video file with `MediaRecorder` and POST it to `/transcribe` instead of running the model in the browser. The mock is built into `server.mjs`. It returns a random phrase after about a second. To use a real model in server mode:

**Model behind an HTTP endpoint (recommended while it runs in Python).** Start the server with the model's URL. `/transcribe` then forwards each clip to it unchanged, so you need no CORS setup:

```sh
TRANSCRIBE_URL=http://localhost:8000/transcribe npm run dev
```

The pill in the header changes from "Mock model" to "Live model".

**Endpoint called directly from the browser.** Set `transcribeUrl` in `public/js/config.js` to its full URL. That server must allow CORS from `http://localhost:3000`.

### Contract the page expects

Request: `POST`, `multipart/form-data`, with the field `video` holding the clip.

Response (JSON):

```json
{ "text": "Can you hear me now?", "confidence": 0.91 }
```

`confidence` is optional (0–1). `transcript` or `prediction` are accepted in place of `text`. To report an error, return a non-2xx status with `{ "error": "message shown to the user" }`.

## Files

| File | Purpose |
|---|---|
| `server.mjs` | Static server, `/models/` (from `../ml/exports/web`, or `MODELS_DIR`), mock `/transcribe`, optional proxy |
| `public/index.html` | Story page (scroll animation) |
| `public/css/story.css`, `public/js/story.js` | Story styles and scroll choreography (GSAP ScrollTrigger + Lenis from CDN) |
| `public/js/mouth.js` | The illustrated mouth shared by the story and about pages |
| `public/about.html` | Product page |
| `public/demo.html` | Live demo page |
| `public/css/base.css` | Shared tokens (colors, fonts), top bar, buttons, footer |
| `public/css/about.css` | Product page styles |
| `public/css/demo.css` | Demo page styles, including the mouth highlight |
| `public/js/nav.js` | Top bar dropdown |
| `public/js/about.js` | Product page hero animation and "play phrase" button |
| `public/js/config.js` | Endpoint URL, field name, clip length limits |
| `public/js/demo.js` | Demo UI state and event wiring |
| `public/js/camera.js` | Webcam + recorder |
| `public/js/mouth-tracker.js` | Face landmarks and the mouth overlay |
| `public/js/transcriber.js` | The single call to the model (browser or server) |
| `public/js/lipread/engine.js` | ONNX Runtime Web setup, model download + cache, inference |
| `public/js/lipread/decode.js` | Beam search / greedy decoding (port of `ml/lipscribe_ml/decode.py`) |
| `public/js/lipread/align.js` | Mouth crops and 25 fps resampling (port of `ml/lipscribe_ml/preprocess.py`) |
| `public/js/lipread/face-target.js` | Face detection and click-to-choose person tracking |
| `public/js/lipread/frame-recorder.js` | Records face windows + keypoints instead of a video file |
| `test/lipread.test.mjs` | Parity tests against the Python pipeline |
| `public/js/speech.js` | Speaking: browser, natural and cloned voices; output device |
| `public/js/voice-clone.js` | Recording and storing the user's own voice sample |
| `lib/tts.mjs` | `/api/tts`: OpenRouter speech, rate limits, proxy mode |
| `lib/env.mjs` | Loads `web/.env` |
| `public/download.html` | Desktop app download page |
| `public/js/storage.js` | History and preferences in `localStorage` |
