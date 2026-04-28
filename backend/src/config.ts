import fs from 'node:fs';
import path from 'node:path';

const envFilePath = path.resolve(process.cwd(), '.env');

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(envFilePath);

export const appConfig = {
  port: Number(process.env.PORT ?? 3001),
  whisperModel: process.env.WHISPER_MODEL ?? 'medium',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL ?? 'gemma3:12b',
  ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 3600000),
  ollamaNumPredict: Number(process.env.OLLAMA_NUM_PREDICT ?? -1),
};
