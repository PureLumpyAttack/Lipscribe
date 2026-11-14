// Load web/.env into process.env (Node's built-in loader). Variables already set
// in the environment win. Imported first by server.mjs so every module sees them.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(file)) process.loadEnvFile(file);
