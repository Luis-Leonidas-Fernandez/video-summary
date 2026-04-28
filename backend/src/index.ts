import './config.js';
import cors from 'cors';
import express from 'express';
import { appConfig } from './config.js';
import { jobsRouter } from './routes/jobs.routes.js';
import { ensureDir, outputRoot } from './utils/files.js';

const app = express();

await ensureDir(outputRoot);

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ollamaBaseUrl: appConfig.ollamaBaseUrl, ollamaModel: appConfig.ollamaModel });
});

app.use('/api/jobs', jobsRouter);

app.listen(appConfig.port, () => {
  console.log(`Video Study Tool backend escuchando en http://localhost:${appConfig.port}`);
});
