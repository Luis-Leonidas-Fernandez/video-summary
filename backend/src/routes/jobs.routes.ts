import { Router } from 'express';
import { promises as fs } from 'node:fs';
import { jobQueue, isValidLanguage, isValidUrl, serializeJob } from '../services/jobQueue.js';
import { safeResolveFile } from '../utils/files.js';
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

function parseSpeakerCountHint(value: unknown): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
    return undefined;
  }

  return parsed;
}

function normalizeUrlList(value: unknown): string[] | undefined {
  if (value == null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function countProvidedSources(body: Partial<CreateJobInput>): number {
  return [Boolean(body.url?.trim()), Array.isArray(body.urls) && body.urls.length > 0, Boolean(body.playlistUrl?.trim())]
    .filter(Boolean)
    .length;
}

async function validateReusableSource(body: Partial<CreateJobInput>): Promise<string | null> {
  if (body.reuseFromJobId == null) {
    return null;
  }

  if (typeof body.reuseFromJobId !== 'string' || body.reuseFromJobId.trim() === '') {
    return 'reuseFromJobId debe ser el ID de un job anterior.';
  }

  if (!body.url || body.urls || body.playlistUrl) {
    return 'reuseFromJobId solo está soportado para jobs de URL única en esta versión.';
  }

  const sourceJob = await jobQueue.resolveJob(body.reuseFromJobId);
  if (!sourceJob) {
    return `El job source ${body.reuseFromJobId} no existe.`;
  }

  if (!['completed', 'completed_with_warnings'].includes(sourceJob.status)) {
    return `El job source debe estar completado para reutilizar su transcripción (estado actual: ${sourceJob.status}).`;
  }

  return null;
}

jobsRouter.post('/', async (req, res) => {
  const body = req.body as Partial<CreateJobInput>;
  body.urls = normalizeUrlList(body.urls);
  const transcriptionLanguage = body.transcriptionLanguage ?? body.language ?? 'auto';
  const outputLanguage = body.outputLanguage ?? 'es';

  if (countProvidedSources(body) !== 1) {
    res.status(400).json({ error: 'Debés enviar exactamente uno de estos campos: url, urls o playlistUrl.' });
    return;
  }

  if (body.url && !isValidUrl(body.url)) {
    res.status(400).json({ error: 'La URL debe ser un enlace http o https válido.' });
    return;
  }

  if (body.playlistUrl && !isValidUrl(body.playlistUrl)) {
    res.status(400).json({ error: 'playlistUrl debe ser un enlace http o https válido.' });
    return;
  }

  if (body.urls && body.urls.some((url) => !isValidUrl(url))) {
    res.status(400).json({ error: 'Todas las URLs de urls[] deben ser enlaces http o https válidos.' });
    return;
  }

  if (!isValidLanguage(transcriptionLanguage)) {
    res.status(400).json({ error: 'transcriptionLanguage debe ser un texto no vacío. Ejemplos válidos: auto, en, es, English, Spanish.' });
    return;
  }

  if (!isValidLanguage(outputLanguage)) {
    res.status(400).json({ error: 'outputLanguage debe ser un texto no vacío. Ejemplos válidos: es, en, English, Spanish.' });
    return;
  }

  if (body.speakerCountHint != null && parseSpeakerCountHint(body.speakerCountHint) == null) {
    res.status(400).json({ error: 'speakerCountHint debe ser un entero entre 1 y 12.' });
    return;
  }

  const reuseValidationError = await validateReusableSource(body);
  if (reuseValidationError) {
    const statusCode = reuseValidationError.includes('no existe') ? 404 : 400;
    res.status(statusCode).json({ error: reuseValidationError });
    return;
  }

  try {
    const job = await jobQueue.createJob({
      url: body.url,
      urls: body.urls,
      playlistUrl: body.playlistUrl,
      language: body.language,
      transcriptionLanguage,
      outputLanguage,
      generateTranscription: body.generateTranscription ?? true,
      generateTranslation: Boolean(body.generateTranslation),
      generateSummary: Boolean(body.generateSummary),
      speakerCountHint: parseSpeakerCountHint(body.speakerCountHint),
      reuseFromJobId: body.reuseFromJobId,
    });

    res.status(202).json(serializeJob(job));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido al crear el job.';
    res.status(400).json({ error: message });
  }
});

jobsRouter.get('/:id', async (req, res) => {
  const job = await jobQueue.resolveJobResponse(req.params.id, DEFAULT_LOG_TAIL);
  if (!job) {
    res.status(404).json({ error: 'Job no encontrado.' });
    return;
  }

  res.json(job);
});

jobsRouter.post('/:id/cancel', async (req, res) => {
  const job = await jobQueue.cancelJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job no encontrado.' });
    return;
  }

  res.json(serializeJob(job));
});

jobsRouter.get('/:id/logs', async (req, res) => {
  const job = await jobQueue.resolveJob(req.params.id);
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

jobsRouter.get('/:id/files', async (req, res) => {
  const job = await jobQueue.resolveJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job no encontrado.' });
    return;
  }

  res.json(job.files);
});

jobsRouter.get('/:id/files/:filename', async (req, res) => {
  const job = await jobQueue.resolveJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job no encontrado.' });
    return;
  }

  try {
    const relativePath = decodeURIComponent(req.params.filename);
    const filePath = safeResolveFile(job.outputDir, relativePath);
    await fs.access(filePath);
    res.sendFile(filePath);
  } catch {
    res.status(404).json({ error: 'Archivo no encontrado.' });
  }
});

jobsRouter.get('/:id/items/:itemId/files', async (req, res) => {
  const job = await jobQueue.resolveJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job no encontrado.' });
    return;
  }

  const item = job.items?.find((candidate) => candidate.itemId === req.params.itemId);
  if (!item) {
    res.status(404).json({ error: 'Item no encontrado.' });
    return;
  }

  res.json(item.files);
});

jobsRouter.get('/:id/items/:itemId/files/:filename', async (req, res) => {
  const job = await jobQueue.resolveJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'Job no encontrado.' });
    return;
  }

  const item = job.items?.find((candidate) => candidate.itemId === req.params.itemId);
  if (!item) {
    res.status(404).json({ error: 'Item no encontrado.' });
    return;
  }

  try {
    const relativePath = decodeURIComponent(req.params.filename);
    const filePath = safeResolveFile(item.outputDir, relativePath);
    await fs.access(filePath);
    res.sendFile(filePath);
  } catch {
    res.status(404).json({ error: 'Archivo no encontrado.' });
  }
});
