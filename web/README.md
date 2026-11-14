# Lipscribe web

Minimal localhost webpage scaffold. No webcam, recording, transcription API, or speech features have been implemented yet.

## Run

Requires Node.js 20 or newer. No dependencies to install. Run from this `web/` folder:

```sh
npm run dev
```

Open http://localhost:3000. Refresh the browser after editing the HTML or CSS. Stop the server with Ctrl+C.

## Files

- `public/index.html`: webpage markup.
- `public/styles.css`: webpage styles.
- `server.mjs`: localhost HTTP server; backend routes can be added here.
- `package.json`: run commands.

## Next steps

Build on this scaffold: live webcam with a mouth guide, start/stop video recording, display the transcript, browser text-to-speech, and transcript history.

The lip-reading model is being prepared in `../ml/` for in-browser inference (ONNX Runtime Web on WebGPU). Until that lands, keep the transcription call behind a configurable API URL so a mock `/transcribe` endpoint can be swapped for the real model.
