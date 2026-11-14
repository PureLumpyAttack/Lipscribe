// Everything you might want to tweak lives here.
export const config = {
  // Where recorded clips are POSTed. The local server answers with a mock
  // until you start it with TRANSCRIBE_URL=<real model url> (see README).
  // You can also point this straight at another origin if it allows CORS.
  transcribeUrl: '/transcribe',

  // Multipart field name the backend reads the video from.
  videoField: 'video',

  maxRecordSeconds: 15,
  minRecordMs: 600,
  requestTimeoutMs: 30_000,
};
