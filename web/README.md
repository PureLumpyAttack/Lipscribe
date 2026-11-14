# Lipscribe web

The Lipscribe website:

- `/`: the story, a full-screen scroll animation that introduces the problem and the idea, ending in buttons to the demo and the about page. The plan behind it is in `STORY-BRIEF.md`.
- `/about`: the product page explaining the project, with buttons into the demo.
- `/demo`: the live demo. It shows a webcam view with everything except the mouth blurred, plus start/stop recording, transcription, text-to-speech playback and transcript history.

## Run

Requires Node.js 20 or newer. There are no dependencies to install. Run from this `web/` folder:

```sh
npm run dev
```

Open http://localhost:3000 in Chrome, Edge or Safari. The demo at http://localhost:3000/demo asks for the camera. Browsers only give camera access on `localhost` or HTTPS. The server restarts itself when `server.mjs` changes. Refresh the browser after editing anything in `public/`.

## How it works

1. `camera.js` opens the webcam (video only) and records clips with `MediaRecorder`.
2. `mouth-tracker.js` loads MediaPipe Face Landmarker from a CDN and finds the lips. The highlight is done in CSS: the video is blurred, and a sharp copy is masked to a soft ellipse around the mouth. If the model can't load, a fixed outline shows where to put your mouth.
3. On stop, `transcriber.js` POSTs the clip to `/transcribe` as `multipart/form-data` (field `video`, WebM or MP4).
4. The result is shown, read aloud with the browser's `speechSynthesis` (`speech.js`), and saved to history in `localStorage` (`storage.js`).

`demo.js` connects these pieces. `config.js` holds the settings you can change.

## Swapping in the real model

The mock is built into `server.mjs`. It returns a random phrase after about a second. There are three ways to replace it, depending on where the model runs:

**Model behind an HTTP endpoint (recommended while it runs in Python).** Start the server with the model's URL. `/transcribe` then forwards each clip to it unchanged, so you need no CORS setup:

```sh
TRANSCRIBE_URL=http://localhost:8000/transcribe npm run dev
```

The pill in the header changes from "Mock model" to "Live model".

**Endpoint called directly from the browser.** Set `transcribeUrl` in `public/js/config.js` to its full URL. That server must allow CORS from `http://localhost:3000`.

**Model running in the browser (ONNX Runtime Web, the plan in `../ml/`).** Replace the body of `transcribe()` in `public/js/transcriber.js` with local inference. Put model files in `public/models/`. Keep the return shape and nothing else needs to change.

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
| `server.mjs` | Static server, mock `/transcribe`, optional proxy to the real model |
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
| `public/js/transcriber.js` | The single call to the model |
| `public/js/speech.js` | Text-to-speech |
| `public/js/storage.js` | History and preferences in `localStorage` |
