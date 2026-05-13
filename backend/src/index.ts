// Opik self-hosted: apunta al backend directo (8080) antes de cargar el SDK
process.env.OPIK_URL_OVERRIDE = process.env.OPIK_URL_OVERRIDE ?? 'http://localhost:5173/api';
process.env.OPIK_API_KEY = process.env.OPIK_API_KEY ?? 'noop';
process.env.OPIK_PROJECT_NAME = process.env.OPIK_PROJECT_NAME ?? 'video-summary';
process.env.OPIK_WORKSPACE = process.env.OPIK_WORKSPACE ?? 'default';

import './config.js';
import cors from 'cors';
import express from 'express';
import { appConfig } from './config.js';
import { jobsRouter } from './routes/jobs.routes.js';
import { jobQueue } from './services/jobQueue.js';
import { aiRuntimeManager } from './services/aiRuntimeManager.js';
import { getHealthResponse } from './services/healthResponse.js';
import { ensureDir, outputRoot } from './utils/files.js';

const app = express();

await ensureDir(outputRoot);
await jobQueue.loadJobsFromDisk();

app.use(cors());
app.use(express.json());

app.get('/api/health', async (_req, res) => {
  res.json(await getHealthResponse());
});

app.use('/api/jobs', jobsRouter);

const server = app.listen(appConfig.port, () => {
  console.log(`Video Study Tool backend escuchando en http://localhost:${appConfig.port}`);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Apagando backend por ${signal}...`);

  server.close(async () => {
    await aiRuntimeManager.stopIfOwned();
    process.exit(0);
  });

  setTimeout(async () => {
    await aiRuntimeManager.stopIfOwned();
    process.exit(1);
  }, 5_000).unref();
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
