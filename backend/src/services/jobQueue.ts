import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  appendLine,
  cloneTranscriptionArtifacts,
  ensureDir,
  listJobFiles,
  outputRoot,
  pathExists,
  readText,
  writeJson,
} from '../utils/files.js';
import { withJobContext, jobLog } from '../utils/jobContext.js';
import { jobRequiresAi, runWithAiRuntime } from './aiJobRuntime.js';
import { aiRuntimeManager } from './aiRuntimeManager.js';
import { modelSelectionService } from './modelSelectionService.js';
import { processVideoJob } from './videoProcessor.js';
import { checkCommandAvailable, runCommand } from '../utils/shell.js';
import type {
  BatchFailurePolicy,
  BatchJobItem,
  BatchSourceType,
  CreateJobInput,
  GroundingStatus,
  ItemStatus,
  JobBatchSummary,
  JobFileEntry,
  JobInputMode,
  JobRecord,
  JobResourceUsage,
  JobResponse,
  JobStatus,
  ResourceUsageScope,
  TranscriptionQuality,
} from '../types.js';

const DEFAULT_LOG_TAIL = 200;
const LOG_RAM_CAP = 1000;
const EVICTION_DELAY_MS = 5 * 60 * 1000;
const MAX_BATCH_ITEMS = 10;
const BATCH_SCHEMA_VERSION = 2;
const DEFAULT_FAILURE_POLICY: BatchFailurePolicy = 'continue_on_item_failure';
const TERMINAL_STATUSES = new Set<JobStatus>(['completed', 'completed_with_warnings', 'failed', 'cancelled']);
const ITEM_TERMINAL_STATUSES = new Set<ItemStatus>(['completed', 'failed', 'cancelled', 'warning']);
const STAGE_PROGRESS: Partial<Record<JobStatus, number>> = {
  queued: 0,
  resolving_sources: 5,
  processing: 10,
  downloading: 15,
  transcribing: 45,
  translating: 65,
  summarizing: 85,
  completed: 100,
  completed_with_warnings: 100,
  failed: 100,
  cancelled: 100,
};

const SUSPICIOUS_PHRASES = ['insupervisto', 'clumpo', 'desfulgada', 'habilidos', 'por diante', 'el edad'];
const SAFE_TECHNICAL_TERMS = new Set([
  'input',
  'output',
  'dataset',
  'datasets',
  'machine',
  'learning',
  'supervisado',
  'clasificacion',
  'regresion',
  'algoritmo',
  'algoritmos',
  'tumor',
  'tumores',
  'benigno',
  'maligno',
  'paciente',
  'pacientes',
  'entorno',
  'entornos',
]);

interface PlaylistDumpEntry {
  id?: string;
  url?: string;
  webpage_url?: string;
  original_url?: string;
}

interface PlaylistDump {
  entries?: PlaylistDumpEntry[];
}

interface GroundingReportLike {
  parts?: Array<{
    finalStatus?: GroundingStatus;
    decisionReason?: string;
    metrics?: {
      invalidCitationCount?: number;
      unsupportedClaimCount?: number;
      totalClaims?: number;
    };
    windowsTooCompressed?: number;
  }>;
}

interface ValidationReportLike {
  parts?: Array<{
    status?: 'accepted' | 'accepted_with_warnings' | 'repaired' | 'failed';
    warnings?: string[];
    strongFlags?: string[];
  }>;
}

class JobQueue {
  private jobs = new Map<string, JobRecord>();
  private queue: string[] = [];
  private isProcessing = false;
  private currentJobId?: string;
  private activeAbortControllers = new Map<string, AbortController>();

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    await ensureDir(outputRoot);

    const timestamp = Date.now();
    const id = `job_${timestamp}`;
    const outputDir = path.join(outputRoot, id);
    await ensureDir(outputDir);

    const inputMode = getInputMode(input);
    const createdAt = new Date().toISOString();
    const originalInput = {
      url: input.url,
      urls: input.urls,
      playlistUrl: input.playlistUrl,
    };

    let reusedFromJobId: string | undefined;
    const initialLogs: string[] = ['Trabajo creado y encolado.'];

    if (input.reuseFromJobId) {
      if (inputMode !== 'single_url') {
        throw new Error('reuseFromJobId solo está soportado para single URL en esta versión.');
      }

      const sourceJob = this.jobs.get(input.reuseFromJobId) ?? await this.readJobFromDisk(input.reuseFromJobId);
      if (!sourceJob) {
        throw new Error(`El job source ${input.reuseFromJobId} no se encuentra en memoria ni en disco.`);
      }

      const sourceItem = sourceJob.items?.[0];
      const sourceDir = sourceItem?.outputDir ?? sourceJob.outputDir;

      try {
        const clone = await cloneTranscriptionArtifacts(sourceDir, outputDir);
        reusedFromJobId = input.reuseFromJobId;
        initialLogs.push(
          `[${new Date().toISOString()}] Reutilizando artefactos de transcripción del job ${input.reuseFromJobId}: ${clone.filesCopied} archivos copiados (${clone.directoriesCopied.join(', ') || 'sin subdirectorios'}).`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Error desconocido al clonar artefactos.';
        throw new Error(`No se pudieron clonar los artefactos del job source: ${message}`);
      }
    }

    const sourceUrls = inputMode === 'playlist'
      ? []
      : normalizeAndDeduplicateUrls(inputMode === 'single_url' ? [input.url ?? ''] : input.urls ?? []);

    if (sourceUrls.length > MAX_BATCH_ITEMS) {
      throw new Error(`El lote supera el límite de ${MAX_BATCH_ITEMS} videos para esta versión.`);
    }

    if (inputMode !== 'playlist' && sourceUrls.length === 0) {
      throw new Error('No hay URLs válidas para procesar.');
    }

    const items = inputMode === 'playlist' ? [] : buildBatchItems(sourceUrls, inputMode, outputDir);
    const job: JobRecord = {
      schemaVersion: BATCH_SCHEMA_VERSION,
      id,
      createdAt,
      updatedAt: createdAt,
      startedAt: undefined,
      completedAt: undefined,
      batchWallClockMs: undefined,
      resourceUsageScope: inputMode === 'single_url' ? 'single_item' : 'batch_aggregate',
      status: inputMode === 'playlist' ? 'resolving_sources' : 'queued',
      url: input.url ?? input.playlistUrl ?? sourceUrls[0] ?? '',
      inputMode,
      originalInput,
      sourceUrls,
      resolvedAt: inputMode === 'playlist' ? undefined : createdAt,
      resolutionError: undefined,
      failurePolicy: DEFAULT_FAILURE_POLICY,
      language: input.transcriptionLanguage ?? input.language ?? 'auto',
      transcriptionLanguage: input.transcriptionLanguage ?? input.language ?? 'auto',
      outputLanguage: input.outputLanguage ?? 'es',
      generateTranscription: input.generateTranscription ?? true,
      generateTranslation: input.generateTranslation,
      generateSummary: input.generateSummary,
      speakerCountHint: input.speakerCountHint,
      reusedFromJobId,
      outputDir,
      files: [],
      items,
      summary: buildBatchSummary(items),
      logs: initialLogs,
      resourceUsage: undefined,
      modelMetadata: undefined,
      error: undefined,
    };

    await this.writeParentLog(job, initialLogs[0], false);
    job.files = await listJobFiles(job.id, job.outputDir);
    this.jobs.set(id, job);
    this.queue.push(id);
    await this.persistJob(job);
    void this.processNext();

    return job;
  }

  getJob(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  getJobResponse(id: string, tail = DEFAULT_LOG_TAIL): JobResponse | undefined {
    const job = this.jobs.get(id);
    if (!job) {
      return undefined;
    }

    return serializeJob(job, tail);
  }

  getJobFiles(id: string, itemId?: string): JobFileEntry[] {
    const job = this.jobs.get(id);
    if (!job) {
      return [];
    }

    if (!itemId) {
      return job.files ?? [];
    }

    return job.items?.find((item) => item.itemId === itemId)?.files ?? [];
  }

  private async readJobFromDisk(id: string): Promise<JobRecord | undefined> {
    const jobJsonPath = path.join(outputRoot, id, 'job.json');
    try {
      const raw = await fs.readFile(jobJsonPath, 'utf-8');
      return normalizeLoadedJobRecord(JSON.parse(raw) as JobRecord);
    } catch {
      return undefined;
    }
  }

  async resolveJob(id: string): Promise<JobRecord | undefined> {
    return this.jobs.get(id) ?? this.readJobFromDisk(id);
  }

  async resolveJobResponse(id: string, tail = DEFAULT_LOG_TAIL): Promise<JobResponse | undefined> {
    const job = await this.resolveJob(id);
    if (!job) return undefined;
    return serializeJob(job, tail);
  }

  async cancelJob(id: string): Promise<JobRecord | undefined> {
    const job = await this.resolveJob(id);
    if (!job) {
      return undefined;
    }

    if (TERMINAL_STATUSES.has(job.status)) {
      return job;
    }

    if (job.status === 'queued' || job.status === 'pending' || job.status === 'resolving_sources') {
      this.queue = this.queue.filter((jobId) => jobId !== id);
      job.status = 'cancelled';
      job.error = 'Trabajo cancelado por el usuario antes de iniciar.';
      markPendingItemsAsCancelled(job, 'Cancelado antes de iniciar.');
      finalizeJobTiming(job);
      job.summary = buildBatchSummary(job.items ?? []);
      job.updatedAt = new Date().toISOString();
      await this.appendParentLog(job, '[batch] cancelled antes de iniciar.');
      await this.persistJob(job);
      this.scheduleEviction(id);
      return job;
    }

    if (this.currentJobId === id) {
      job.status = 'cancelling';
      job.updatedAt = new Date().toISOString();
      await this.appendParentLog(job, '[batch] cancel requested by user.');
      await this.persistJob(job);
      this.activeAbortControllers.get(id)?.abort();
      await aiRuntimeManager.forceStopAll();
      return job;
    }

    return job;
  }

  async resolveJobItem(id: string, itemId: string): Promise<BatchJobItem | undefined> {
    const job = await this.resolveJob(id);
    return job?.items?.find((item) => item.itemId === itemId);
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing) {
      return;
    }

    const nextJobId = this.queue.shift();
    if (!nextJobId) {
      return;
    }

    const job = await this.resolveJob(nextJobId);
    if (!job) {
      return;
    }

    this.jobs.set(job.id, job);
    this.isProcessing = true;
    this.currentJobId = nextJobId;
    const abortController = new AbortController();
    this.activeAbortControllers.set(nextJobId, abortController);

    try {
      await withJobContext(job.id, async () => {
        if (!job.startedAt) {
          job.startedAt = new Date().toISOString();
        }

        if (job.generateSummary || job.generateTranslation) {
          job.modelMetadata = await modelSelectionService.getFrozenJobModelMetadata();
        }

        await this.appendParentLog(
          job,
          `[job-start] mode=${job.inputMode ?? 'single_url'} transcriptionLanguage=${job.transcriptionLanguage} outputLanguage=${job.outputLanguage} generateTranscription=${job.generateTranscription} generateTranslation=${job.generateTranslation} generateSummary=${job.generateSummary} reusedFromJobId=${job.reusedFromJobId ?? 'none'} ollamaModelUsed=${job.modelMetadata?.ollamaModelUsed ?? 'n/a'} modelSelectionSource=${job.modelMetadata?.modelSelectionSource ?? 'n/a'}`,
        );

        if ((job.inputMode ?? 'single_url') === 'playlist' && (!job.items || job.items.length === 0)) {
          await this.resolvePlaylistSources(job, abortController.signal);
        }

        if (job.status === 'failed' || job.status === 'cancelled') {
          finalizeJobTiming(job);
          job.resourceUsage = buildAggregateJobResourceUsage(job);
          job.updatedAt = new Date().toISOString();
          await this.persistJob(job);
          return;
        }

        if (!job.items || job.items.length === 0) {
          job.status = 'failed';
          job.error = job.resolutionError ?? 'No se pudieron resolver items válidos para el lote.';
          finalizeJobTiming(job);
          job.resourceUsage = buildAggregateJobResourceUsage(job);
          job.updatedAt = new Date().toISOString();
          await this.appendParentLog(job, '[batch] failed: no valid items after resolution.');
          await this.persistJob(job);
          return;
        }

        job.status = 'processing';
        job.summary = buildBatchSummary(job.items);
        job.updatedAt = new Date().toISOString();
        await this.persistJob(job);

        await runWithAiRuntime(jobRequiresAi(job.generateSummary, job.generateTranslation), async () => {
          await this.processJobItems(job, abortController.signal);
        });
      });
    } catch {
      // Los errores ya quedan persistidos en el job.
    } finally {
      this.activeAbortControllers.delete(nextJobId);
      this.scheduleEviction(nextJobId);
      this.currentJobId = undefined;
      this.isProcessing = false;
      void this.processNext();
    }
  }

  private async processJobItems(job: JobRecord, signal: AbortSignal): Promise<void> {
    const items = job.items ?? [];

    for (const item of items) {
      if (signal.aborted || job.status === 'cancelling') {
        break;
      }

      if (ITEM_TERMINAL_STATUSES.has(item.status)) {
        continue;
      }

      await this.processSingleItem(job, item, signal);

      if (job.failurePolicy === 'fail_fast' && item.status === 'failed') {
        break;
      }
    }

    if (signal.aborted || job.status === 'cancelling') {
      markPendingItemsAsCancelled(job, 'Cancelado por el usuario durante el lote.');
      job.status = 'cancelled';
      job.error = 'Trabajo cancelado por el usuario.';
      job.summary = buildBatchSummary(job.items ?? []);
      finalizeJobTiming(job);
      job.resourceUsage = buildAggregateJobResourceUsage(job);
      job.updatedAt = new Date().toISOString();
      await this.appendParentLog(job, `[batch-summary] status=${job.status} totalItems=${job.summary.totalItems} completedItems=${job.summary.completedItems} warningItems=${job.summary.warningItems} failedItems=${job.summary.failedItems} cancelledItems=${job.summary.cancelledItems} batchWallClockMs=${job.batchWallClockMs ?? 0} model=${job.modelMetadata?.ollamaModelUsed ?? 'n/a'} inputMode=${job.inputMode ?? 'single_url'}`);
      await this.persistJob(job);
      return;
    }

    job.summary = buildBatchSummary(job.items ?? []);
    job.status = deriveParentStatus(job.items ?? []);
    job.error = deriveParentError(job.items ?? []);
    finalizeJobTiming(job);
    job.resourceUsage = buildAggregateJobResourceUsage(job);
    job.updatedAt = new Date().toISOString();
    job.files = await listJobFiles(job.id, job.outputDir);
    await this.appendParentLog(job, `[batch-summary] status=${job.status} totalItems=${job.summary.totalItems} completedItems=${job.summary.completedItems} warningItems=${job.summary.warningItems} failedItems=${job.summary.failedItems} cancelledItems=${job.summary.cancelledItems} batchWallClockMs=${job.batchWallClockMs ?? 0} model=${job.modelMetadata?.ollamaModelUsed ?? 'n/a'} inputMode=${job.inputMode ?? 'single_url'}`);
    await this.persistJob(job);
  }

  private async processSingleItem(job: JobRecord, item: BatchJobItem, signal: AbortSignal): Promise<void> {
    item.status = 'processing';
    item.progress = STAGE_PROGRESS.processing;
    item.currentStage = 'processing';
    item.startedAt = item.startedAt ?? new Date().toISOString();
    item.completedAt = undefined;
    item.itemWallClockMs = undefined;
    item.warnings = [];
    job.summary = buildBatchSummary(job.items ?? [], item.itemId);
    job.updatedAt = new Date().toISOString();
    await ensureDir(item.outputDir);
    await this.persistJob(job);
    await this.appendParentLog(job, `[batch] item:start itemId=${item.itemId} sourceUrl=${item.sourceUrl}`);

    const itemJob: JobRecord = {
      ...job,
      id: `${job.id}:${item.itemId}`,
      status: 'processing',
      url: item.sourceUrl,
      outputDir: item.outputDir,
      files: item.files,
      items: undefined,
      summary: undefined,
      logs: [],
      error: undefined,
    };

    const syncItemFiles = async () => {
      item.files = await listJobFiles(job.id, item.outputDir, item.itemId);
      job.files = await listJobFiles(job.id, job.outputDir);
      job.updatedAt = new Date().toISOString();
      await this.persistJob(job);
    };

    try {
      await processVideoJob(itemJob, {
        updateStatus: async (status) => {
          applyStageToItem(item, status);
          job.status = 'processing';
          job.summary = buildBatchSummary(job.items ?? [], item.itemId);
          job.updatedAt = new Date().toISOString();
          await this.persistJob(job);
        },
        appendLog: async (message) => {
          job.logs.push(message);
          if (job.logs.length > LOG_RAM_CAP) {
            job.logs = job.logs.slice(-LOG_RAM_CAP);
          }
          job.updatedAt = new Date().toISOString();
          await this.persistJob(job);
          if ((job.inputMode ?? 'single_url') !== 'single_url') {
            await this.writeParentLog(job, `[${item.itemId}] ${message}`, true);
          }
        },
        refreshFiles: syncItemFiles,
        setResourceUsage: async (summary) => {
          item.resourceUsage = summary;
          job.resourceUsage = (job.inputMode ?? 'single_url') === 'single_url' ? summary : buildAggregateJobResourceUsage(job);
          job.resourceUsageScope = (job.inputMode ?? 'single_url') === 'single_url' ? 'single_item' : 'batch_aggregate';
          job.updatedAt = new Date().toISOString();
          await this.persistJob(job);
        },
        failJob: async (message) => {
          item.status = 'failed';
          item.error = message;
          item.progress = 100;
          item.currentStage = undefined;
          item.completedAt = new Date().toISOString();
          item.itemWallClockMs = calculateDurationMs(item.startedAt, item.completedAt);
          job.summary = buildBatchSummary(job.items ?? [], item.itemId);
          job.updatedAt = new Date().toISOString();
          await this.persistJob(job);
        },
        cancelJob: async (message) => {
          item.status = 'cancelled';
          item.error = message;
          item.progress = 100;
          item.currentStage = undefined;
          item.completedAt = new Date().toISOString();
          item.itemWallClockMs = calculateDurationMs(item.startedAt, item.completedAt);
          job.summary = buildBatchSummary(job.items ?? [], item.itemId);
          job.updatedAt = new Date().toISOString();
          await this.persistJob(job);
        },
      }, signal);
    } catch {
      // processVideoJob ya dejó el estado del item persistido.
    } finally {
      if (item.status === 'processing') {
        item.progress = 100;
        item.currentStage = undefined;
        item.completedAt = new Date().toISOString();
        item.itemWallClockMs = calculateDurationMs(item.startedAt, item.completedAt);
      }

      await syncItemFiles();
      await enrichItemFromArtifacts(item);
      if ((job.inputMode ?? 'single_url') === 'single_url') {
        job.detectedSourceLanguage = item.detectedSourceLanguage;
        job.translationStatus = item.translationStatus;
      }
      item.status = deriveItemStatusFromSignals(item);
      item.completedAt = item.completedAt ?? new Date().toISOString();
      item.itemWallClockMs = item.itemWallClockMs ?? calculateDurationMs(item.startedAt, item.completedAt);
      job.summary = buildBatchSummary(job.items ?? []);
      job.resourceUsage = (job.inputMode ?? 'single_url') === 'single_url' ? item.resourceUsage : buildAggregateJobResourceUsage(job);
      job.resourceUsageScope = (job.inputMode ?? 'single_url') === 'single_url' ? 'single_item' : 'batch_aggregate';
      job.updatedAt = new Date().toISOString();
      await this.persistJob(job);
      await this.appendItemSummaryLog(job, item);
      await this.appendParentLog(
        job,
        `[batch] item:${item.status} itemId=${item.itemId} transcriptionQuality=${item.transcriptionQuality ?? 'unknown'} groundingStatus=${item.groundingStatus ?? 'unknown'} durationMs=${item.itemWallClockMs ?? 0}`,
      );
    }
  }

  private async resolvePlaylistSources(job: JobRecord, signal: AbortSignal): Promise<void> {
    if (!job.originalInput?.playlistUrl) {
      job.status = 'failed';
      job.resolutionError = 'Falta playlistUrl para resolver las fuentes.';
      job.error = job.resolutionError;
      job.updatedAt = new Date().toISOString();
      await this.persistJob(job);
      return;
    }

    job.status = 'resolving_sources';
    job.updatedAt = new Date().toISOString();
    await this.persistJob(job);
    await this.appendParentLog(job, '[batch] resolving_sources:start');

    if (!(await checkCommandAvailable('yt-dlp'))) {
      const message = 'yt-dlp no está disponible para resolver playlists.';
      job.status = 'failed';
      job.resolutionError = message;
      job.error = message;
      job.updatedAt = new Date().toISOString();
      await this.persistJob(job);
      return;
    }

    let stdout = '';

    try {
      await runCommand({
        command: 'yt-dlp',
        args: ['--flat-playlist', '--dump-single-json', job.originalInput.playlistUrl],
        signal,
        onStdout: (chunk) => {
          stdout += chunk;
        },
        onStderr: async (chunk) => {
          const lines = chunk.split(/\r?\n/).filter(Boolean);
          for (const line of lines) {
            await this.appendParentLog(job, `[playlist:stderr] ${line}`);
          }
        },
      });

      const parsed = JSON.parse(stdout) as PlaylistDump;
      const entries = parsed.entries ?? [];
      const urls = normalizeAndDeduplicateUrls(entries.map(toVideoUrl).filter((value): value is string => Boolean(value)));

      if (urls.length === 0) {
        throw new Error('Playlist returned no valid videos');
      }

      if (urls.length > MAX_BATCH_ITEMS) {
        throw new Error(`La playlist supera el límite de ${MAX_BATCH_ITEMS} videos para esta versión.`);
      }

      job.sourceUrls = urls;
      job.items = buildBatchItems(urls, 'playlist', job.outputDir);
      job.summary = buildBatchSummary(job.items);
      job.resolvedAt = new Date().toISOString();
      job.resolutionError = undefined;
      job.error = undefined;
      job.status = 'queued';
      job.updatedAt = new Date().toISOString();
      await this.appendParentLog(job, `[batch] resolving_sources:end totalItems=${urls.length}`);
      await this.persistJob(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo resolver la playlist.';
      if (signal.aborted) {
        markPendingItemsAsCancelled(job, 'Cancelado durante la resolución de playlist.');
        job.status = 'cancelled';
        job.error = 'Trabajo cancelado por el usuario.';
      } else {
        job.status = 'failed';
        job.resolutionError = message;
        job.error = message;
      }
      finalizeJobTiming(job);
      job.updatedAt = new Date().toISOString();
      await this.appendParentLog(job, `[batch] resolving_sources:failed reason=${message}`);
      await this.persistJob(job);
    }
  }

  async loadJobsFromDisk(): Promise<void> {
    let entries: import('node:fs').Dirent[];

    try {
      entries = await fs.readdir(outputRoot, { withFileTypes: true });
    } catch {
      return;
    }

    const jobDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('job_'))
      .sort((left, right) => left.name.localeCompare(right.name));

    let fixedCount = 0;

    for (const entry of jobDirs) {
      const jobJsonPath = path.join(outputRoot, entry.name, 'job.json');

      try {
        const raw = await fs.readFile(jobJsonPath, 'utf-8');
        const loaded = normalizeLoadedJobRecord(JSON.parse(raw) as JobRecord);

        if (!TERMINAL_STATUSES.has(loaded.status)) {
          loaded.status = 'failed';
          loaded.error = 'El servidor se reinició mientras el job estaba en curso.';
          loaded.updatedAt = new Date().toISOString();
          loaded.logs.push(`[${loaded.updatedAt}] Job marcado como fallido por reinicio del servidor.`);
          if (loaded.items) {
            for (const item of loaded.items) {
              if (!ITEM_TERMINAL_STATUSES.has(item.status)) {
                item.status = 'failed';
                item.error = 'El servidor se reinició mientras este item estaba en curso.';
                item.completedAt = loaded.updatedAt;
                item.itemWallClockMs = calculateDurationMs(item.startedAt, item.completedAt);
              }
            }
            loaded.summary = buildBatchSummary(loaded.items);
          }
          finalizeJobTiming(loaded);
          loaded.resourceUsage = buildAggregateJobResourceUsage(loaded);
          await this.persistJob(loaded);
          fixedCount += 1;
        }
      } catch {
        // job.json corrupto o ausente
      }
    }

    console.log(`[jobQueue] ${jobDirs.length} job(s) en disco (${fixedCount} corregidos), ninguno precargado en RAM.`);
  }

  private scheduleEviction(id: string): void {
    setTimeout(() => {
      this.jobs.delete(id);
    }, EVICTION_DELAY_MS);
  }

  private async persistJob(job: JobRecord): Promise<void> {
    await writeJson(path.join(job.outputDir, 'job.json'), job);
  }

  private async writeParentLog(job: JobRecord, message: string, alreadyPersistedInMemory: boolean): Promise<void> {
    const timestamped = ensureTimestamped(message);
    if (!alreadyPersistedInMemory) {
      job.logs.push(timestamped);
      if (job.logs.length > LOG_RAM_CAP) {
        job.logs = job.logs.slice(-LOG_RAM_CAP);
      }
    }
    await appendLine(path.join(job.outputDir, 'logs.txt'), timestamped);
    jobLog(timestamped);
  }

  private async appendParentLog(job: JobRecord, message: string): Promise<void> {
    const timestamped = ensureTimestamped(message);
    job.logs.push(timestamped);
    if (job.logs.length > LOG_RAM_CAP) {
      job.logs = job.logs.slice(-LOG_RAM_CAP);
    }
    job.updatedAt = new Date().toISOString();
    await appendLine(path.join(job.outputDir, 'logs.txt'), timestamped);
    await this.persistJob(job);
    jobLog(timestamped);
  }

  private async appendItemSummaryLog(job: JobRecord, item: BatchJobItem): Promise<void> {
    const line = ensureTimestamped(
      `[item-summary] itemId=${item.itemId} status=${item.status} transcriptionQuality=${item.transcriptionQuality ?? 'unknown'} groundingStatus=${item.groundingStatus ?? 'unknown'} claimsValidated=${item.claimsValidated ?? 0} unsupportedClaims=${item.unsupportedClaimCount ?? 0} invalidCitations=${item.invalidCitationCount ?? 0} windowsTooCompressed=${item.windowsTooCompressed ?? 0} durationMs=${item.itemWallClockMs ?? 0} peakRssMb=${item.resourceUsage?.peakRssMb ?? 0}`,
    );
    await appendLine(path.join(item.outputDir, 'logs.txt'), line);
    if ((job.inputMode ?? 'single_url') === 'single_url') {
      const lastRootLine = job.logs[job.logs.length - 1];
      if (lastRootLine !== line) {
        job.logs.push(line);
        if (job.logs.length > LOG_RAM_CAP) {
          job.logs = job.logs.slice(-LOG_RAM_CAP);
        }
      }
    }
  }
}

function normalizeLoadedJobRecord(job: JobRecord): JobRecord {
  const normalizedFiles = normalizeJobFiles(job.files ?? [], job.id, job.outputDir);
  const inputMode = job.inputMode ?? 'single_url';

  if (job.schemaVersion === BATCH_SCHEMA_VERSION) {
    const normalizedItems = (job.items ?? []).map((item) => ({
      ...item,
      files: normalizeJobFiles(item.files ?? [], job.id, item.outputDir, item.itemId),
    }));

    const normalizedJob = {
      ...job,
      schemaVersion: BATCH_SCHEMA_VERSION,
      inputMode,
      language: job.language ?? job.transcriptionLanguage ?? 'auto',
      transcriptionLanguage: job.transcriptionLanguage ?? job.language ?? 'auto',
      outputLanguage: job.outputLanguage ?? 'es',
      sourceUrls: job.sourceUrls ?? (job.url ? [normalizeSourceUrl(job.url)] : []),
      items: normalizedItems,
      files: normalizedFiles,
      summary: buildBatchSummary(normalizedItems, job.summary?.activeItemId),
      failurePolicy: job.failurePolicy ?? DEFAULT_FAILURE_POLICY,
      resourceUsageScope: job.resourceUsageScope ?? (inputMode === 'single_url' ? 'single_item' : 'batch_aggregate'),
    } satisfies JobRecord;

    if (!normalizedJob.batchWallClockMs) {
      finalizeJobTiming(normalizedJob);
    }
    if (!normalizedJob.resourceUsage) {
      normalizedJob.resourceUsage = buildAggregateJobResourceUsage(normalizedJob);
    }

    return normalizedJob;
  }

  const legacyItem: BatchJobItem = {
    itemId: 'item_001',
    index: 0,
    sourceUrl: job.url,
    normalizedUrl: normalizeSourceUrl(job.url),
    sourceType: 'single',
    status: mapLegacyJobStatusToItemStatus(job.status),
    outputDir: job.outputDir,
    files: normalizedFiles.map((file) => ({ ...file, itemId: 'item_001' })),
    error: job.error,
    progress: deriveLegacyProgress(job.status),
    startedAt: job.startedAt ?? job.createdAt,
    completedAt: job.completedAt ?? (TERMINAL_STATUSES.has(job.status) ? job.updatedAt : undefined),
    itemWallClockMs: calculateDurationMs(job.startedAt ?? job.createdAt, job.completedAt ?? (TERMINAL_STATUSES.has(job.status) ? job.updatedAt : undefined)),
    currentStage: isPipelineStage(job.status) ? job.status : undefined,
    resourceUsage: job.resourceUsage,
  };

  const normalizedLegacy: JobRecord = {
    ...job,
    schemaVersion: 1,
    inputMode: 'single_url',
    language: job.language ?? 'auto',
    transcriptionLanguage: job.transcriptionLanguage ?? job.language ?? 'auto',
    outputLanguage: job.outputLanguage ?? 'es',
    originalInput: { url: job.url },
    sourceUrls: [normalizeSourceUrl(job.url)],
    resolvedAt: job.createdAt,
    failurePolicy: DEFAULT_FAILURE_POLICY,
    startedAt: job.startedAt ?? job.createdAt,
    completedAt: job.completedAt ?? (TERMINAL_STATUSES.has(job.status) ? job.updatedAt : undefined),
    batchWallClockMs: job.batchWallClockMs ?? calculateDurationMs(job.startedAt ?? job.createdAt, job.completedAt ?? (TERMINAL_STATUSES.has(job.status) ? job.updatedAt : undefined)),
    resourceUsageScope: job.resourceUsageScope ?? 'single_item',
    files: normalizedFiles,
    items: [legacyItem],
    summary: buildBatchSummary([legacyItem]),
  };

  return normalizedLegacy;
}

function normalizeJobFiles(files: JobFileEntry[], jobId: string, rootDir: string, itemId?: string): JobFileEntry[] {
  return files.map((file) => {
    const relativePath = file.relativePath ?? path.relative(rootDir, file.path ?? path.join(rootDir, file.name ?? file.filename));
    const filename = file.filename ?? file.name ?? path.basename(relativePath);
    const encodedPath = encodeURIComponent(relativePath);
    const downloadUrl = itemId
      ? `/api/jobs/${jobId}/items/${encodeURIComponent(itemId)}/files/${encodedPath}`
      : `/api/jobs/${jobId}/files/${encodedPath}`;

    return {
      ...file,
      itemId: file.itemId ?? itemId,
      name: file.name ?? filename,
      filename,
      relativePath,
      downloadUrl: file.downloadUrl ?? downloadUrl,
    };
  });
}

function getInputMode(input: CreateJobInput): JobInputMode {
  const provided = [Boolean(input.url?.trim()), Array.isArray(input.urls) && input.urls.length > 0, Boolean(input.playlistUrl?.trim())].filter(Boolean).length;
  if (provided !== 1) {
    throw new Error('Debés enviar exactamente uno de estos campos: url, urls o playlistUrl.');
  }

  if (input.url?.trim()) return 'single_url';
  if (Array.isArray(input.urls) && input.urls.length > 0) return 'url_list';
  return 'playlist';
}

function normalizeAndDeduplicateUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rawUrl of urls) {
    const value = rawUrl.trim();
    if (!value || !isValidUrl(value)) {
      continue;
    }
    const normalized = normalizeSourceUrl(value);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function normalizeSourceUrl(rawUrl: string): string {
  const url = new URL(rawUrl.trim());
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  const pathname = url.pathname.replace(/\/+$/, '');

  const youtubeVideoId = (() => {
    if (host === 'youtu.be') {
      return pathname.split('/').filter(Boolean)[0] ?? '';
    }
    if (host.endsWith('youtube.com')) {
      if (url.searchParams.get('v')) {
        return url.searchParams.get('v') ?? '';
      }
      const parts = pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' || parts[0] === 'embed') {
        return parts[1] ?? '';
      }
    }
    return '';
  })();

  if (youtubeVideoId) {
    return `https://www.youtube.com/watch?v=${youtubeVideoId}`;
  }

  const normalized = new URL(url.toString());
  normalized.hash = '';
  const sorted = [...normalized.searchParams.entries()]
    .filter(([key]) => !['si', 'list', 'index'].includes(key.toLowerCase()))
    .sort(([left], [right]) => left.localeCompare(right));
  normalized.search = '';
  for (const [key, value] of sorted) {
    normalized.searchParams.append(key, value);
  }

  return normalized.toString();
}

function buildBatchItems(sourceUrls: string[], inputMode: JobInputMode, outputDir: string): BatchJobItem[] {
  const sourceType: BatchSourceType = inputMode === 'single_url' ? 'single' : inputMode === 'url_list' ? 'batch_list' : 'playlist';
  return sourceUrls.map((sourceUrl, index) => {
    const itemId = `item_${String(index + 1).padStart(3, '0')}`;
    return {
      itemId,
      index,
      sourceUrl,
      normalizedUrl: normalizeSourceUrl(sourceUrl),
      sourceType,
      status: 'pending',
      outputDir: inputMode === 'single_url' ? outputDir : path.join(outputDir, itemId),
      files: [],
      progress: 0,
      warnings: [],
    } satisfies BatchJobItem;
  });
}

function buildBatchSummary(items: BatchJobItem[], activeItemId?: string): JobBatchSummary {
  const summary: JobBatchSummary = {
    totalItems: items.length,
    completedItems: items.filter((item) => item.status === 'completed').length,
    failedItems: items.filter((item) => item.status === 'failed').length,
    cancelledItems: items.filter((item) => item.status === 'cancelled').length,
    pendingItems: items.filter((item) => item.status === 'pending').length,
    warningItems: items.filter((item) => item.status === 'warning').length,
    activeItemId,
  };

  if (!summary.activeItemId) {
    summary.activeItemId = items.find((item) => item.status === 'processing')?.itemId;
  }

  return summary;
}

function deriveParentStatus(items: BatchJobItem[]): JobStatus {
  if (items.length === 0) {
    return 'failed';
  }

  const total = items.length;
  const completed = items.filter((item) => item.status === 'completed').length;
  const warnings = items.filter((item) => item.status === 'warning').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const cancelled = items.filter((item) => item.status === 'cancelled').length;

  if (completed === total) {
    return 'completed';
  }

  if (failed === total) {
    return 'failed';
  }

  if (cancelled === total) {
    return 'cancelled';
  }

  if (completed + warnings === total) {
    return 'completed_with_warnings';
  }

  if (completed > 0 || warnings > 0 || failed > 0 || cancelled > 0) {
    return 'completed_with_warnings';
  }

  return 'failed';
}

function deriveParentError(items: BatchJobItem[]): string | undefined {
  const firstFailed = items.find((item) => item.status === 'failed' && item.error);
  if (firstFailed) {
    return firstFailed.error;
  }

  const firstWarning = items.find((item) => item.status === 'warning' && item.warnings?.length);
  if (firstWarning) {
    return firstWarning.warnings?.[0];
  }

  const firstCancelled = items.find((item) => item.status === 'cancelled' && item.error);
  return firstCancelled?.error;
}

function applyStageToItem(item: BatchJobItem, status: JobStatus): void {
  if (status === 'completed') {
    item.status = 'completed';
    item.progress = 100;
    item.currentStage = undefined;
    item.completedAt = new Date().toISOString();
    return;
  }

  if (status === 'completed_with_warnings') {
    item.status = 'warning';
    item.progress = 100;
    item.currentStage = undefined;
    item.completedAt = new Date().toISOString();
    return;
  }

  if (status === 'failed') {
    item.status = 'failed';
    item.progress = 100;
    item.currentStage = undefined;
    item.completedAt = new Date().toISOString();
    return;
  }

  if (status === 'cancelled') {
    item.status = 'cancelled';
    item.progress = 100;
    item.currentStage = undefined;
    item.completedAt = new Date().toISOString();
    return;
  }

  item.status = 'processing';
  item.currentStage = isPipelineStage(status) ? status : 'processing';
  item.progress = STAGE_PROGRESS[status] ?? item.progress ?? 0;
}

type PipelineStage = 'pending' | 'processing' | 'downloading' | 'transcribing' | 'translating' | 'summarizing';

function isPipelineStage(status: JobStatus): status is PipelineStage {
  return status === 'pending' || status === 'processing' || status === 'downloading' || status === 'transcribing' || status === 'translating' || status === 'summarizing';
}

function mapLegacyJobStatusToItemStatus(status: JobStatus): ItemStatus {
  if (status === 'completed') return 'completed';
  if (status === 'completed_with_warnings') return 'warning';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  return 'processing';
}

function deriveLegacyProgress(status: JobStatus): number {
  return STAGE_PROGRESS[status] ?? (TERMINAL_STATUSES.has(status) ? 100 : 0);
}

function markPendingItemsAsCancelled(job: JobRecord, reason: string): void {
  for (const item of job.items ?? []) {
    if (ITEM_TERMINAL_STATUSES.has(item.status)) {
      continue;
    }
    item.status = 'cancelled';
    item.error = reason;
    item.progress = 100;
    item.currentStage = undefined;
    item.completedAt = new Date().toISOString();
    item.itemWallClockMs = calculateDurationMs(item.startedAt, item.completedAt);
  }
}

function toVideoUrl(entry: PlaylistDumpEntry): string | undefined {
  if (entry.webpage_url && isValidUrl(entry.webpage_url)) {
    return entry.webpage_url;
  }
  if (entry.original_url && isValidUrl(entry.original_url)) {
    return entry.original_url;
  }
  if (entry.url && isValidUrl(entry.url)) {
    return entry.url;
  }
  if (entry.id) {
    return `https://www.youtube.com/watch?v=${entry.id}`;
  }
  return undefined;
}

async function enrichItemFromArtifacts(item: BatchJobItem): Promise<void> {
  const warnings = new Set(item.warnings ?? []);
  const itemJobPath = path.join(item.outputDir, 'job.json');

  if (await pathExists(itemJobPath)) {
    try {
      const raw = await fs.readFile(itemJobPath, 'utf-8');
      const itemJob = JSON.parse(raw) as Partial<JobRecord>;
      if (itemJob.detectedSourceLanguage) {
        item.detectedSourceLanguage = itemJob.detectedSourceLanguage;
      }
      if (itemJob.translationStatus) {
        item.translationStatus = itemJob.translationStatus;
      }
    } catch {
      warnings.add('item_job_metadata_unreadable');
    }
  }

  const transcriptionPath = path.join(item.outputDir, 'transcription.txt');
  if (await pathExists(transcriptionPath)) {
    const transcription = await readText(transcriptionPath);
    const quality = assessTranscriptionQuality(transcription);
    item.transcriptionQuality = quality.quality;
    if (quality.reasons.length > 0) {
      for (const reason of quality.reasons) warnings.add(reason);
    }
  }

  const groundingPath = path.join(item.outputDir, 'grounding_report.json');
  if (await pathExists(groundingPath)) {
    try {
      const raw = await fs.readFile(groundingPath, 'utf-8');
      const report = JSON.parse(raw) as GroundingReportLike;
      const part = report.parts?.[0];
      item.groundingStatus = part?.finalStatus ?? 'unknown';
      item.groundingDecisionReason = part?.decisionReason;
      item.claimsValidated = part?.metrics?.totalClaims ?? 0;
      item.unsupportedClaimCount = part?.metrics?.unsupportedClaimCount ?? 0;
      item.invalidCitationCount = part?.metrics?.invalidCitationCount ?? 0;
      item.windowsTooCompressed = part?.windowsTooCompressed ?? 0;

      if (item.groundingStatus && item.groundingStatus !== 'grounded') {
        warnings.add(`grounding:${item.groundingStatus}`);
      }
      if ((item.unsupportedClaimCount ?? 0) > 0) warnings.add('claims_unsupported');
      if ((item.invalidCitationCount ?? 0) > 0) warnings.add('invalid_citations');
      if ((item.windowsTooCompressed ?? 0) > 0) warnings.add('windows_too_compressed');
      if (item.groundingDecisionReason) warnings.add(item.groundingDecisionReason);
    } catch {
      warnings.add('grounding_report_unreadable');
      item.groundingStatus = 'unknown';
    }
  }

  const validationPath = path.join(item.outputDir, 'validation_report.json');
  if (await pathExists(validationPath)) {
    try {
      const raw = await fs.readFile(validationPath, 'utf-8');
      const report = JSON.parse(raw) as ValidationReportLike;
      const hasLegacyWarnings = report.parts?.some(
        (part) => part.status && part.status !== 'accepted',
      );
      if (hasLegacyWarnings) {
        warnings.add('legacy_validation_warning');
        item.groundingStatus = item.groundingStatus ?? 'legacy_warning';
      }
    } catch {
      warnings.add('validation_report_unreadable');
    }
  }

  item.warnings = [...warnings];
}

function deriveItemStatusFromSignals(item: BatchJobItem): ItemStatus {
  if (item.status === 'failed' || item.status === 'cancelled') {
    return item.status;
  }

  if (item.groundingStatus === 'failed_grounding') {
    return 'failed';
  }

  if (
    item.transcriptionQuality === 'poor'
    || item.transcriptionQuality === 'suspicious'
    || item.groundingStatus === 'partially_grounded'
    || item.groundingStatus === 'needs_human_review'
    || item.groundingStatus === 'too_compressed'
    || item.groundingStatus === 'legacy_warning'
    || (item.unsupportedClaimCount ?? 0) > 0
    || (item.invalidCitationCount ?? 0) > 0
    || (item.windowsTooCompressed ?? 0) > 0
    || (item.warnings?.length ?? 0) > 0
  ) {
    return 'warning';
  }

  return 'completed';
}

function assessTranscriptionQuality(text: string): { quality: TranscriptionQuality; reasons: string[] } {
  const normalized = text.toLowerCase();
  const words = normalized.match(/[a-záéíóúñü]{3,}/g) ?? [];
  const suspiciousPhraseHits = SUSPICIOUS_PHRASES.filter((phrase) => normalized.includes(phrase));

  let repeatedTriples = 0;
  for (let index = 0; index < words.length - 2; index += 1) {
    if (words[index] === words[index + 1] && words[index] === words[index + 2]) {
      repeatedTriples += 1;
    }
  }

  const noVowelWords = words.filter((word) => !/[aeiouáéíóúü]/.test(word));
  const longWeirdWords = words.filter((word) => word.length >= 14 && !SAFE_TECHNICAL_TERMS.has(word));
  const suspiciousScore = suspiciousPhraseHits.length * 2 + repeatedTriples * 2 + noVowelWords.length + longWeirdWords.length;

  const reasons: string[] = [];
  if (suspiciousPhraseHits.length > 0) reasons.push(`suspicious_phrases:${suspiciousPhraseHits.join(',')}`);
  if (repeatedTriples > 0) reasons.push(`repeated_triplets:${repeatedTriples}`);
  if (noVowelWords.length > 0) reasons.push(`no_vowel_tokens:${noVowelWords.length}`);
  if (longWeirdWords.length > 0) reasons.push(`long_weird_tokens:${longWeirdWords.length}`);

  if (suspiciousScore >= 5) {
    return { quality: 'poor', reasons };
  }
  if (suspiciousScore >= 2) {
    return { quality: 'suspicious', reasons };
  }
  return { quality: 'ok', reasons: [] };
}

function buildAggregateJobResourceUsage(job: JobRecord): JobResourceUsage | undefined {
  const items = job.items ?? [];
  const itemUsages = items.map((item) => item.resourceUsage).filter((usage): usage is JobResourceUsage => Boolean(usage));

  if ((job.inputMode ?? 'single_url') === 'single_url') {
    return itemUsages[0] ?? job.resourceUsage;
  }

  if (itemUsages.length === 0) {
    return job.resourceUsage;
  }

  const lastUsage = itemUsages[itemUsages.length - 1];
  const monitoringErrors = itemUsages.map((usage) => usage.monitoringError).filter(Boolean);

  return {
    durationMs: job.batchWallClockMs ?? lastUsage.durationMs,
    peakRssMb: Math.max(...itemUsages.map((usage) => usage.peakRssMb)),
    peakCpuPercent: Math.max(...itemUsages.map((usage) => usage.peakCpuPercent)),
    finalRssMb: lastUsage.finalRssMb,
    finalCpuPercent: lastUsage.finalCpuPercent,
    peakProcessCount: Math.max(...itemUsages.map((usage) => usage.peakProcessCount)),
    finalProcessCount: lastUsage.finalProcessCount,
    monitoringError: monitoringErrors.length > 0 ? monitoringErrors.join(' | ') : undefined,
  } satisfies JobResourceUsage;
}

function calculateDurationMs(startedAt?: string, completedAt?: string): number | undefined {
  if (!startedAt || !completedAt) {
    return undefined;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return undefined;
  }
  return end - start;
}

function finalizeJobTiming(job: JobRecord): void {
  if (!job.startedAt) {
    return;
  }
  job.completedAt = job.completedAt ?? new Date().toISOString();
  job.batchWallClockMs = calculateDurationMs(job.startedAt, job.completedAt);
}

function ensureTimestamped(message: string): string {
  if (/^\[\d{4}-\d{2}-\d{2}T/.test(message)) {
    return message;
  }
  return `[${new Date().toISOString()}] ${message}`;
}

export function serializeJob(job: JobRecord, tail = DEFAULT_LOG_TAIL): JobResponse {
  const normalized = normalizeLoadedJobRecord(job);
  const safeTail = Math.max(0, tail);
  const logs = safeTail > 0 ? normalized.logs.slice(-safeTail) : [];

  return {
    schemaVersion: normalized.schemaVersion,
    id: normalized.id,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    startedAt: normalized.startedAt,
    completedAt: normalized.completedAt,
    batchWallClockMs: normalized.batchWallClockMs,
    resourceUsageScope: normalized.resourceUsageScope,
    status: normalized.status,
    url: normalized.url,
    inputMode: normalized.inputMode,
    originalInput: normalized.originalInput,
    sourceUrls: normalized.sourceUrls,
    resolvedAt: normalized.resolvedAt,
    resolutionError: normalized.resolutionError,
    failurePolicy: normalized.failurePolicy,
    language: normalized.language,
    transcriptionLanguage: normalized.transcriptionLanguage,
    outputLanguage: normalized.outputLanguage,
    generateTranscription: normalized.generateTranscription,
    generateTranslation: normalized.generateTranslation,
    generateSummary: normalized.generateSummary,
    speakerCountHint: normalized.speakerCountHint,
    reusedFromJobId: normalized.reusedFromJobId,
    outputDir: normalized.outputDir,
    files: normalized.files,
    items: normalized.items,
    summary: normalized.summary,
    logs,
    logCount: normalized.logs.length,
    logsTruncated: normalized.logs.length > logs.length,
    resourceUsage: normalized.resourceUsage,
    modelMetadata: normalized.modelMetadata,
    detectedSourceLanguage: normalized.detectedSourceLanguage,
    translationStatus: normalized.translationStatus,
    error: normalized.error,
    progress: deriveJobProgress(normalized),
  };
}

function deriveJobProgress(job: JobRecord): number {
  if (job.status === 'resolving_sources') {
    return STAGE_PROGRESS.resolving_sources ?? 5;
  }

  const items = job.items ?? [];
  if (items.length === 0) {
    return TERMINAL_STATUSES.has(job.status) ? 100 : 0;
  }

  const completedUnits = items.reduce((total, item) => {
    if (item.status === 'completed' || item.status === 'warning' || item.status === 'failed' || item.status === 'cancelled') {
      return total + 1;
    }
    if (item.status === 'processing') {
      return total + Math.min(1, Math.max(0, (item.progress ?? 0) / 100));
    }
    return total;
  }, 0);

  return Math.max(0, Math.min(100, Math.round((completedUnits / items.length) * 100)));
}

export const jobQueue = new JobQueue();

export function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isValidLanguage(value: string): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
