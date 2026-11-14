// Everything you might want to tweak lives here.
export const config = {
  // 'browser': the lip-reading model runs in this tab (ONNX Runtime Web, WebGPU).
  // 'server': clips are POSTed to transcribeUrl instead (mock or proxy, see README).
  engine: 'browser',

  // Where the browser model files live. Locally (and in the desktop app, which
  // bundles them) server.mjs serves ../ml/exports/web/ at /models/ (build it with
  // ml/scripts/package_web.py). The deployed site loads them from a public
  // Cloudflare R2 bucket (upload with ml/scripts/upload_r2.py). Any URL that
  // allows CORS works.
  modelBaseUrl: ['localhost', '127.0.0.1'].includes(location.hostname)
    ? '/models/'
    : 'https://pub-c53f822c6d244cff9e2513da77916a51.r2.dev/',

  // Beam search width. 10 matches the accuracy of 40 within 0.6 WER points
  // (see ml/README.md); 0 = greedy CTC, fastest but ~4 points worse.
  beamSize: 10,

  // engine: 'server' only. Where recorded clips are POSTed. The local server answers with a mock
  // until you start it with TRANSCRIBE_URL=<real model url> (see README).
  // You can also point this straight at another origin if it allows CORS.
  transcribeUrl: '/transcribe',

  // Multipart field name the backend reads the video from.
  videoField: 'video',

  // Hands-free mode: record automatically while your lips move
  // (lipread/speech-detector.js). Lower startLevel = more sensitive.
  handsFree: {
    startLevel: 0.01, // lip motion that counts as talking
    startRange: 0.05, // ...and how far the mouth must open and close
    stopLevel: 0.005, // below this counts as still
    stopMs: 900, // still this long = done talking (pauses between words are shorter)
    minSpeechMs: 700, // shorter movements (a smile, a cough) are ignored
  },

  maxRecordSeconds: 15,
  minRecordMs: 600,
  requestTimeoutMs: 30_000,
};
