# Lipscribe

Minimal localhost webpage scaffold. No webcam, recording, transcription API, or speech features have been implemented yet.

## Run

Requires Node.js 20 or newer. No dependencies to install.

```sh
npm run dev
```

Open http://localhost:3000. Refresh the browser after editing the HTML or CSS. Stop the server with Ctrl+C.

## Files

- `public/index.html`: webpage markup.
- `public/styles.css`: webpage styles.
- `server.mjs`: localhost HTTP server; backend routes can be added here.
- `package.json`: run commands.

## Handoff to Claude Code

Build on this scaffold: live webcam with a mouth guide, start/stop video recording, POST video to a mock `/transcribe` endpoint, display the transcript, browser text-to-speech, and transcript history. Keep the API URL configurable so the real backend can replace the mock. The current site is only a static starting point.

## Push to main

Run from this project folder:

```sh
git add .
git commit -m "Set up Lipscribe localhost webpage"
git branch -M main
git push -u origin main
```

The cloned repository already has `origin` set to https://github.com/PureLumpyAttack/Lipscribe.git. No commit or push was performed during setup.
