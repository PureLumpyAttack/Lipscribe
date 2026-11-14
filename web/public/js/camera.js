// Webcam access and clip recording. Video only: lip reading needs no audio.

export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'user',
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

const MIME_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

function pickMimeType() {
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type)) ?? '';
}

export function createRecorder(stream) {
  let recorder = null;
  let chunks = [];
  let startedAt = 0;

  return {
    get recording() {
      return recorder?.state === 'recording';
    },

    start() {
      const mimeType = pickMimeType();
      chunks = [];
      recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : {});
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.start(250);
      startedAt = performance.now();
    },

    // Resolves with { blob, durationMs } once the recorder has flushed.
    stop() {
      return new Promise((resolve, reject) => {
        if (!recorder || recorder.state === 'inactive') {
          reject(new Error('Not recording.'));
          return;
        }
        const durationMs = performance.now() - startedAt;
        recorder.onstop = () => {
          resolve({ blob: new Blob(chunks, { type: recorder.mimeType || 'video/webm' }), durationMs });
        };
        recorder.onerror = (event) => reject(event.error ?? new Error('Recording failed.'));
        recorder.stop();
      });
    },
  };
}
