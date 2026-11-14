// Everything you might want to tweak lives here.
export const config = {
  // 'browser': the lip-reading model runs in this tab (ONNX Runtime Web, WebGPU).
  // 'server': clips are POSTed to transcribeUrl instead (mock or proxy, see README).
  engine: 'browser',

  // Where the browser model files live. server.mjs serves ../ml/exports/web/ here
  // (build it with ml/scripts/package_web.py). Can be any URL that allows CORS.
  modelBaseUrl: '/models/',

  // Beam search width. 10 matches the accuracy of 40 within 0.6 WER points
  // (see ml/README.md); 0 = greedy CTC, fastest but ~4 points worse.
  beamSize: 10,

  // engine: 'server' only. Where recorded clips are POSTed. The local server answers with a mock
  // until you start it with TRANSCRIBE_URL=<real model url> (see README).
  // You can also point this straight at another origin if it allows CORS.
  transcribeUrl: '/transcribe',

  // Multipart field name the backend reads the video from.
  videoField: 'video',

  maxRecordSeconds: 15,
  minRecordMs: 600,
  requestTimeoutMs: 30_000,
};
