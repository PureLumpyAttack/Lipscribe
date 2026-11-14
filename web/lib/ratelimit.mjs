// Rate limits for /api/tts, shared across server instances through Upstash
// Redis (REST API, no client library). Vercel runs many short-lived instances,
// so in-memory counters alone would reset constantly and not be shared.
//
// Env: KV_REST_API_URL + KV_REST_API_TOKEN (names from Vercel's Upstash
// integration) or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
// Without them (local dev, desktop app) the same limits are kept in memory.
// If Redis can't be reached, the in-memory limits apply instead of failing open.

const REDIS_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const WINDOW_S = 10 * 60;
const DAY_S = 24 * 60 * 60;

/** Run commands in one round trip. Returns the result of each command. */
async function redis(commands) {
  const response = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`Redis HTTP ${response.status}`);
  const results = await response.json();
  const failed = results.find((r) => r.error);
  if (failed) throw new Error(`Redis: ${failed.error}`);
  return results.map((r) => r.result);
}

// In-memory fallback: key -> { value, expires }.
const memory = new Map();
function memIncr(key, by, ttl) {
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.expires <= now) {
    memory.set(key, { value: by, expires: now + ttl * 1000 });
    if (memory.size > 10_000) for (const [k, e] of memory) if (e.expires <= now) memory.delete(k);
    return by;
  }
  entry.value += by;
  return entry.value;
}

/** Add to several counters at once. counters: [{ key, by, ttl }] -> new values. */
async function incr(counters) {
  if (REDIS_URL && REDIS_TOKEN) {
    try {
      // INCRBY then EXPIRE NX: the window starts at the first hit and is never extended.
      const commands = counters.flatMap(({ key, by, ttl }) => [['INCRBY', key, by], ['EXPIRE', key, ttl, 'NX']]);
      const results = await redis(commands);
      return counters.map((_, i) => Number(results[i * 2]));
    } catch (error) {
      console.error(`[ratelimit] ${error.message}; using in-memory limits`);
    }
  }
  return counters.map(({ key, by, ttl }) => memIncr(key, by, ttl));
}

export const rateLimitBackend = () => (REDIS_URL && REDIS_TOKEN ? 'redis' : 'memory');

/**
 * Count one request of `chars` characters from `ip` and check the limits.
 * Returns null when allowed, or a message for the user.
 */
export async function checkTtsLimits(ip, chars, limits) {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / WINDOW_S);
  const day = new Date().toISOString().slice(0, 10);
  const [requests, ipChars, allChars] = await incr([
    { key: `lipscribe:tts:req:${ip}:${window}`, by: 1, ttl: WINDOW_S },
    { key: `lipscribe:tts:chars:${ip}:${day}`, by: chars, ttl: 2 * DAY_S },
    { key: `lipscribe:tts:chars:all:${day}`, by: chars, ttl: 2 * DAY_S },
  ]);
  if (requests > limits.perIpRequests) return 'Too many voice requests. Wait a few minutes and try again.';
  if (ipChars > limits.perIpDailyChars) return "You've used today's natural voice allowance. The browser voices still work.";
  if (allChars > limits.dailyChars) return 'The natural voice is out of quota for today. The browser voices still work.';
  return null;
}
