import { cleanupRuntime } from './runtime-control.mjs';

const includeOllama = process.argv.includes('--include-ollama');

function log(message) {
  console.log(`[video-study-tool:cleanup] ${message}`);
}

cleanupRuntime({ includeOllama, logger: log });
