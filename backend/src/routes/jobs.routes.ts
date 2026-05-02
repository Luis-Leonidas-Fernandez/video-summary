import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { jobQueue, isValidLanguage, isValidUrl, serializeJob } from '../services/jobQueue.js';
import type { CreateJobInput, JobLogsResponse } from '../types.js';

export const jobsRouter = Router();
const DEFAULT_LOG_TAIL = 200;
const MAX_LOG_TAIL = 1000;

function parseTailParam(value: unknown, fallback = DEFAULT_LOG_TAIL): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), MAX_LOG_TAIL);
}

jobsRouter.post('/', async (req, res) => {
  const body = req.body as Partial<CreateJobInput>;

  if (!body.url || !isValidUrl(body.url)) {
    res.status(400).json({ error: 'La URL debe ser un enlace http o https válido.' });
    return;
  }

  if (!body.language || !isValidLanguage(body.language)) {
    res.status(400).json({ error: 'language debe ser un texto no vacío. Ejemplos válidos: auto, en, es, English, Spanish.' });
    return;
  }

  const job = await jobQueue.createJob({
    url: body.url,
    language: body.language,
    generateTranscription: body.generateTranscription ?? true,
    generateTranslation: Boolean(body.generateTranslation),
    generateSummary: Boolean(body.generateSummary),
  });

  res.status(202).json(serializeJob(job));
});

jobsRouter.get('/:id', (req, res) => {
  const job = jobQueue.getJobResponse(req.params.id, DEFAULT_LOG_TAIL);
  if (!job) {
    res.status(404).json({ error: 'Job no encontrado.' });
    return;
  }

  res.json(job);
});

jobsRouter.get('/:id/logs', (req, res) => {
  const job = jobQueue.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job no encontrado.' });
    return;
  }

  const tail = parseTailParam(req.query.tail);
  const logs = tail > 0 ? job.logs.slice(-tail) : [];

  const response: JobLogsResponse = {
    jobId: job.id,
    logs,
    logCount: job.logs.length,
    tail,
    logsTruncated: job.logs.length > logs.length,
  };

  res.json(response);
});

jobsRouter.get('/:id/files', (req, res) => {
  const job = jobQueue.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job no encontrado.' });
    return;
  }

  res.json(job.files);
});

jobsRouter.get('/:id/files/:filename', async (req, res) => {
  const job = jobQueue.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job no encontrado.' });
    return;
  }

  const fileName = path.basename(req.params.filename);
  const filePath = path.join(job.outputDir, fileName);

  try {
    await fs.access(filePath);
    res.sendFile(filePath);
  } catch {
    res.status(404).json({ error: 'Archivo no encontrado.' });
  }
});
