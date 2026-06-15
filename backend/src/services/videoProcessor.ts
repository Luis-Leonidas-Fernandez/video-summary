import path from 'node:path';
import { promises as fs } from 'node:fs';
import { opik, setActiveTrace, setActiveParentSpan } from './opikTracer.js';
import { appConfig } from '../config.js';
import { completeOllamaResponse } from './ollamaClient.js';
import type { ChunkManifestChunk } from './groundingTypes.js';
import type { JobResourceUsage, JobStatus, TranslationStatus } from '../types.js';
import {
  consolidateExtractions,
  generateExtractionForPart,
  type ValidationReportPart,
} from './studyExtraction.js';
import { formatChunkId, formatPartId, generateGroundingArtifacts, type GroundingPartInput } from './studyGroundingPipeline.js';
import type { GroundingPerformanceSummary } from './groundingTypes.js';
import {
  generateGlossary,
  generateKeyConcepts,
  generateOutline,
  generateStudyQuestions,
} from './studyArtifacts.js';
import { aiRuntimeManager } from './aiRuntimeManager.js';
import { createJobResourceMonitor } from './jobResourceMonitor.js';
import { annotateChunkSpeakerAwareness, buildSpeakerAwarenessLogLine } from './speakerAwarenessService.js';
import { postprocessTranscription } from './transcriptionPostprocessor.js';
import { partitionVideoAudio } from './videoPartitioner.js';
import { transcribeAudio, validateWhisperCpp } from './whisperCpp.js';
import { appendLine, ensureDir, listJobFiles, pathExists, readText, writeJson, writeText, writeTextAtomic } from '../utils/files.js';
import { checkCommandAvailable, runCommand } from '../utils/shell.js';
import type { JobRecord } from '../types.js';

interface ProcessJobHooks {
  updateStatus: (status: JobStatus) => Promise<void>;
  appendLog: (message: string) => Promise<void>;
  refreshFiles: () => Promise<void>;
  setResourceUsage: (summary: JobResourceUsage) => Promise<void>;
  failJob: (message: string) => Promise<void>;
  cancelJob: (message: string) => Promise<void>;
}

const REQUIRED_COMMANDS = ['yt-dlp', 'ffmpeg'] as const;
const MIN_VALID_ARTIFACT_LENGTH = 40;
const SPANISH_STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'que', 'y', 'en', 'por', 'para', 'con', 'una', 'un', 'como', 'se', 'al',
  'pero', 'más', 'mas', 'esto', 'esta', 'este', 'porque', 'sobre', 'cuando', 'puede', 'puedes',
]);
const ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'of', 'to', 'is', 'in', 'for', 'with', 'you', 'this', 'that', 'from', 'are', 'your', 'will',
  'can', 'use', 'look', 'please', 'while', 'now', 'how',
]);

interface SpanishOutputResolution {
  detectedSourceLanguage: string
  translationStatus: TranslationStatus
  spanishTextPath: string
}

interface TranscriptionChunkArtifact {
  partId: string
  chunkOrder: number
  transcriptionPath: string
  translationPath: string
  text: string
}

interface StudyPart {
  partNumber: number;
  audioPath: string;
  transcriptionPath: string;
  extractionPath: string;
  chunks: ChunkManifestChunk[];
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError'
    || error.message.includes('Command aborted:')
    || error.message.includes('Ollama agotó el tiempo de espera')
    || error.message.includes('cancel')
  )
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('El pipeline fue cancelado por el usuario.')
    error.name = 'AbortError'
    throw error
  }
}

export async function validateDependencies(): Promise<void> {
  const results = await Promise.all(
    REQUIRED_COMMANDS.map(async (command) => ({
      command,
      exists: await checkCommandAvailable(command),
    })),
  );

  const missing = results.filter((item) => !item.exists).map((item) => item.command);
  if (missing.length > 0) {
    throw new Error(
      `Faltan herramientas del sistema: ${missing.join(', ')}. Instalá yt-dlp y ffmpeg con Homebrew antes de procesar videos.`,
    );
  }

  await validateWhisperCpp();
}

export async function processVideoJob(job: JobRecord, hooks: ProcessJobHooks, signal?: AbortSignal): Promise<void> {
  await ensureDir(job.outputDir);
  const activeLlmModel = job.modelMetadata?.ollamaModelUsed ?? appConfig.defaultOllamaModel;
  const logFilePath = path.join(job.outputDir, 'logs.txt');
  const resourceStagesPath = path.join(job.outputDir, 'resource_stages.jsonl');
  const resourceMonitor = createJobResourceMonitor({
    includeOllama: job.generateSummary,
  });

  const opikTrace = opik.trace({
    name: 'video.pipeline',
    input: { jobId: job.id, url: job.url, model: activeLlmModel },
  });
  setActiveTrace(opikTrace);

  let traceTranscription = '';
  let traceStudyNotes = '';
  let traceSummary = '';

  const log = async (message: string): Promise<void> => {
    const timestamped = `[${new Date().toISOString()}] ${message}`;
    await hooks.appendLog(timestamped);
    await appendLine(logFilePath, timestamped);
  };

  const persistJobFile = async (): Promise<void> => {
    await writeJson(path.join(job.outputDir, 'job.json'), job);
  };

  const recordStageSnapshot = async (stage: string, metadata?: Record<string, unknown>): Promise<void> => {
    const snapshot = resourceMonitor.captureStage(stage, metadata);
    await appendLine(resourceStagesPath, JSON.stringify(snapshot));
  };

  let resourceSummaryLogged = false;
  const logResourceSummary = async (): Promise<void> => {
    if (resourceSummaryLogged) {
      return;
    }

    resourceSummaryLogged = true;
    const summary = await resourceMonitor.stop();
    await hooks.setResourceUsage(summary);
    const durationSeconds = Number((summary.durationMs / 1000).toFixed(1));

    await log(
      `Recursos del job: pico RAM ${summary.peakRssMb} MB, pico CPU ${summary.peakCpuPercent}%, RAM final ${summary.finalRssMb} MB, CPU final ${summary.finalCpuPercent}%, pico procesos ${summary.peakProcessCount}, procesos finales ${summary.finalProcessCount}, duración monitorizada ${durationSeconds}s.`,
    );

    if (summary.monitoringError) {
      await log(`Advertencia de monitoreo de recursos: ${summary.monitoringError}`);
    }
  };

  try {
    throwIfCancelled(signal)
    await log('Iniciando validación de dependencias del sistema.');
    await validateDependencies();
    await persistJobFile();

    let audioPath: string;
    const downloadSpan = opikTrace.span({ name: 'pipeline.download', type: 'general' });
    setActiveParentSpan(downloadSpan);
    try {
      audioPath = await downloadAudio(job, log, hooks, signal);
      downloadSpan.update({ output: { audioPath } });
    } finally {
      downloadSpan.end();
      setActiveParentSpan(null);
    }

    throwIfCancelled(signal)

    let transcriptionPath: string;
    const transcribeSpan = opikTrace.span({ name: 'pipeline.transcribe', type: 'general' });
    setActiveParentSpan(transcribeSpan);
    try {
      transcriptionPath = await runTranscription(job, audioPath!, log, hooks, signal);
      traceTranscription = await readText(transcriptionPath).catch(() => '');
      transcribeSpan.update({ output: { transcriptionPath, transcription: traceTranscription } });
    } finally {
      transcribeSpan.end();
      setActiveParentSpan(null);
    }

    throwIfCancelled(signal)

    if (!job.generateTranscription) {
      await log('La opción de transcripción original fue desactivada. Se mantiene el archivo porque traducción/resumen dependen de la transcripción en este MVP.');
    }

    const spanishOutput = await ensureSpanishReadableText(job, transcriptionPath, log, hooks)
    job.detectedSourceLanguage = spanishOutput.detectedSourceLanguage
    job.translationStatus = spanishOutput.translationStatus
    await persistJobFile()

    if (job.generateSummary) {
      await hooks.updateStatus('summarizing');
      await log(`Generando material de estudio exhaustivo con Ollama (${activeLlmModel}).`);
      await log(
        `Perfil Ollama full notes: num_ctx=${appConfig.fullNotesOllamaNumCtx}, num_predict=${appConfig.fullNotesOllamaNumPredict}, keep_alive=${appConfig.ollamaKeepAlive}.`,
      );
      const summarizeSpan = opikTrace.span({ name: 'pipeline.summarize', type: 'general' });
      setActiveParentSpan(summarizeSpan);
      try {
        const studyOutputs = await generateStudyOutputs(
          job.id,
          job.outputDir,
          spanishOutput.spanishTextPath,
          log,
          recordStageSnapshot,
          hooks.refreshFiles,
          job.speakerCountHint,
          signal,
        );
        traceStudyNotes = await readText(path.join(job.outputDir, 'full_study_notes_es.txt')).catch(() => '');
        traceSummary = await readText(path.join(job.outputDir, 'summary_es.txt')).catch(() => '');
        summarizeSpan.update({
          output: {
            completedWithWarnings: studyOutputs.completedWithWarnings,
            fullStudyNotes: traceStudyNotes,
            summary: traceSummary,
          },
        });
        await hooks.refreshFiles();
        await persistJobFile();
        if (studyOutputs.completedWithWarnings) {
          await log('El job terminó con advertencias: una o más ventanas quedaron en needs_review o con validaciones parciales.');
        }
        job.status = studyOutputs.completedWithWarnings ? 'completed_with_warnings' : 'completed';
      } finally {
        summarizeSpan.end();
        setActiveParentSpan(null);
      }
    }

    if (job.generateSummary) {
      await log('Descargando modelo de Ollama al terminar el job para liberar RAM.');
      await recordStageSnapshot('unloadModel:start');
      await aiRuntimeManager.unloadModel();
      await recordStageSnapshot('unloadModel:end');
    }

    await hooks.updateStatus(job.status === 'completed_with_warnings' ? 'completed_with_warnings' : 'completed');
    await hooks.refreshFiles();
    await persistJobFile();
    await logResourceSummary();
    await log('Trabajo completado correctamente.');
    opikTrace.update({
      output: {
        status: job.status,
        transcription: traceTranscription,
        studyNotes: traceStudyNotes,
        summary: traceSummary,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido durante el procesamiento.';
    opikTrace.update({
      output: {
        error: message,
        transcription: traceTranscription,
        studyNotes: traceStudyNotes,
        summary: traceSummary,
      },
    });
    if (isCancellationError(error) || signal?.aborted) {
      await logResourceSummary();
      await log('Trabajo cancelado por el usuario. Se frenó el pipeline y se pidió apagar el runtime/modelo de IA.');
      await hooks.cancelJob('Trabajo cancelado por el usuario.');
      await persistJobFile();
      throw error instanceof Error ? error : new Error(message);
    }

    if (job.generateSummary) {
      await recordStageSnapshot('unloadModel:start', { reason: 'error' });
      await aiRuntimeManager.unloadModel();
      await recordStageSnapshot('unloadModel:end', { reason: 'error' });
    }
    await logResourceSummary();
    await log(`ERROR: ${message}`);
    await hooks.failJob(message);
    await persistJobFile();
    throw error;
  } finally {
    opikTrace.end();
    setActiveTrace(null);
    setActiveParentSpan(null);
    await opik.flush();
  }
}

async function downloadAudio(
  job: JobRecord,
  log: (message: string) => Promise<void>,
  hooks: Pick<ProcessJobHooks, 'updateStatus' | 'refreshFiles'>,
  signal?: AbortSignal,
): Promise<string> {
  await hooks.updateStatus('downloading');

  const outputTemplate = path.join(job.outputDir, 'audio.%(ext)s');
  const audioPath = path.join(job.outputDir, 'audio.mp3');

  if (await isValidArtifact(audioPath)) {
    await log(`Reutilizando audio ya descargado en ${audioPath}.`);
    await hooks.refreshFiles();
    return audioPath;
  }

  await log(`Descargando audio desde: ${job.url}`);

  await runCommand({
    command: 'yt-dlp',
    args: ['-x', '--audio-format', 'mp3', '--no-playlist', '-o', outputTemplate, job.url],
    signal,
    onStdout: async (chunk) => {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        await log(`[yt-dlp] ${line}`);
      }
    },
    onStderr: async (chunk) => {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        await log(`[yt-dlp:stderr] ${line}`);
      }
    },
  });

  if (!(await pathExists(audioPath))) {
    const candidates = (await fs.readdir(job.outputDir))
      .filter((file) => file.startsWith('audio.'))
      .map((file) => path.join(job.outputDir, file));

    if (candidates.length === 0) {
      throw new Error('yt-dlp terminó sin generar un archivo de audio reconocible.');
    }

    if (candidates[0] !== audioPath) {
      await fs.rename(candidates[0], audioPath);
    }
  }

  await hooks.refreshFiles();
  await log(`Audio disponible en ${audioPath}`);
  return audioPath;
}

async function denoiseAudio(
  job: JobRecord,
  audioPath: string,
  log: (message: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<string> {
  const denoisedAudioPath = path.join(job.outputDir, 'audio_denoised.wav');

  if (await isValidArtifact(denoisedAudioPath)) {
    await log(`Reutilizando audio con denoise ya existente en ${denoisedAudioPath}.`);
    return denoisedAudioPath;
  }

  await log(`Aplicando denoise previo con ffmpeg usando filtro: ${appConfig.whisperDenoiseFilter}`);

  await runCommand({
    command: 'ffmpeg',
    args: [
      '-y',
      '-i',
      audioPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-af',
      appConfig.whisperDenoiseFilter,
      denoisedAudioPath,
    ],
    signal,
    onStdout: async (chunk) => {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        await log(`[ffmpeg] ${line}`);
      }
    },
    onStderr: async (chunk) => {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        await log(`[ffmpeg] ${line}`);
      }
    },
  });

  if (!(await pathExists(denoisedAudioPath))) {
    throw new Error('ffmpeg terminó, pero no generó audio_denoised.wav.');
  }

  await log(`Audio normalizado y con denoise disponible en ${denoisedAudioPath}`);
  return denoisedAudioPath;
}

async function segmentPartForTranscription(
  segmentDir: string,
  partAudioPath: string,
  partLabel: string,
  log: (message: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<string[]> {
  const segmentPattern = path.join(segmentDir, 'chunk_%03d.wav');

  await ensureDir(segmentDir);
  const existingSegments = (await fs.readdir(segmentDir).catch(() => []))
    .filter((file) => file.endsWith('.wav'))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => path.join(segmentDir, file));

  if (existingSegments.length > 0) {
    await log(`Reutilizando ${existingSegments.length} subchunks ya existentes para ${partLabel}.`);
    return existingSegments;
  }

  await log(
    `Segmentando ${partLabel} para Whisper en bloques de ${appConfig.whisperChunkDurationSeconds} segundos.`,
  );

  await runCommand({
    command: 'ffmpeg',
    args: [
      '-y',
      '-i',
      partAudioPath,
      '-f',
      'segment',
      '-segment_start_number',
      '1',
      '-segment_time',
      String(appConfig.whisperChunkDurationSeconds),
      '-c',
      'copy',
      segmentPattern,
    ],
    signal,
    onStdout: async (chunk) => {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        await log(`[ffmpeg:segment] ${line}`);
      }
    },
    onStderr: async (chunk) => {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        await log(`[ffmpeg:segment] ${line}`);
      }
    },
  });

  const segments = (await fs.readdir(segmentDir))
    .filter((file) => file.endsWith('.wav'))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => path.join(segmentDir, file));

  if (segments.length === 0) {
    throw new Error('ffmpeg segmentó el audio, pero no generó chunks para transcripción.');
  }

  await log(`${partLabel} segmentada en ${segments.length} subchunks.`);
  return segments;
}

async function runTranscription(
  job: JobRecord,
  audioPath: string,
  log: (message: string) => Promise<void>,
  hooks: Pick<ProcessJobHooks, 'updateStatus' | 'refreshFiles'>,
  signal?: AbortSignal,
): Promise<string> {
  await hooks.updateStatus('transcribing');
  const denoisedAudioPath = await denoiseAudio(job, audioPath, log, signal);
  const videoParts = await partitionVideoAudio({
    outputDir: job.outputDir,
    inputAudioPath: denoisedAudioPath,
    log,
    signal,
  });
  const languageLabel =
    job.transcriptionLanguage.trim().toLowerCase() === 'auto' || job.transcriptionLanguage.trim() === ''
      ? 'detección automática de idioma'
      : `idioma forzado: ${job.transcriptionLanguage.trim()}`;
  await log(`Transcribiendo audio con whisper.cpp (${languageLabel}) usando modelo ${path.basename(appConfig.whisperCppModelPath)}.`);

  const transcriptionPath = path.join(job.outputDir, 'transcription.txt');
  const studyParts = await transcribeVideoParts({
    job,
    videoParts,
    log,
    signal,
  });

  const partTranscriptions = await Promise.all(
    studyParts.map(async (part) => {
      const content = (await readText(part.transcriptionPath)).trim();
      return content;
    }),
  );

  await log('Aplicando postproceso de transcripción para deduplicar repeticiones consecutivas.');
  const mergedTranscription = `${partTranscriptions.filter(Boolean).join('\n\n').trim()}\n`;
  const cleanedTranscription = postprocessTranscription(mergedTranscription);
  await writeText(transcriptionPath, cleanedTranscription);

  await hooks.refreshFiles();
  await log(`Transcripción guardada en ${transcriptionPath}`);
  return transcriptionPath;
}

function normalizeLanguageLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

function isSpanishLanguage(value: string): boolean {
  const normalized = normalizeLanguageLabel(value)
  return normalized === 'es' || normalized === 'espanol' || normalized === 'spanish'
}

function detectSourceLanguageFromTranscription(transcription: string): string {
  const normalized = transcription
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
  const words = normalized.match(/[a-zñ]{2,}/g) ?? []
  const sample = words.slice(0, 400)

  let spanishScore = 0
  let englishScore = 0

  for (const word of sample) {
    if (SPANISH_STOPWORDS.has(word)) spanishScore += 1
    if (ENGLISH_STOPWORDS.has(word)) englishScore += 1
  }

  const accentedHits = (transcription.match(/[áéíóúñ¿¡]/gi) ?? []).length
  spanishScore += accentedHits * 2

  if (spanishScore >= Math.max(englishScore * 1.35, 8)) {
    return 'es'
  }

  if (englishScore >= Math.max(spanishScore * 1.35, 8)) {
    return 'en'
  }

  return spanishScore > 0 && englishScore > 0 ? 'mixed' : 'unknown'
}

async function collectTranscriptionChunks(outputDir: string): Promise<TranscriptionChunkArtifact[]> {
  const entries = await fs.readdir(outputDir).catch(() => []);
  const chunks = await Promise.all(entries
    .map(async (fileName) => {
      const match = fileName.match(/^transcription_chunk_(\d{3})_(\d{3})\.txt$/)
      if (!match?.[1] || !match[2]) {
        return null
      }

      const transcriptionPath = path.join(outputDir, fileName)
      const text = (await readText(transcriptionPath).catch(() => '')).trim()
      if (!text) {
        return null
      }

      const partId = match[1]
      const chunkOrder = Number(match[2])
      return {
        partId,
        chunkOrder,
        transcriptionPath,
        translationPath: path.join(outputDir, `translation_chunk_${partId}_${match[2]}.txt`),
        text,
      } satisfies TranscriptionChunkArtifact
    }))

  return chunks
    .filter((value): value is TranscriptionChunkArtifact => Boolean(value))
    .sort((left, right) => {
      if (left.partId === right.partId) {
        return left.chunkOrder - right.chunkOrder
      }
      return left.partId.localeCompare(right.partId)
    })
}

async function isValidTranslationChunk(filePath: string): Promise<boolean> {
  if (!(await pathExists(filePath))) {
    return false
  }

  const stats = await fs.stat(filePath).catch(() => null)
  if (!stats || stats.size === 0) {
    return false
  }

  const content = await readText(filePath).catch(() => '')
  return content.trim().length > 0
}

async function hasReusableTranslatedArtifacts(outputDir: string): Promise<boolean> {
  const translationPath = path.join(outputDir, 'translation_es.txt')
  if (!(await isValidArtifact(translationPath))) {
    return false
  }

  const entries = await fs.readdir(outputDir).catch(() => [])
  const transcriptionPartCount = entries.filter((fileName) => /^transcription_part_\d{3}\.txt$/.test(fileName)).length
  const translationPartCount = entries.filter((fileName) => /^translation_part_\d{3}\.txt$/.test(fileName)).length
  const transcriptionChunkCount = entries.filter((fileName) => /^transcription_chunk_\d{3}_\d{3}\.txt$/.test(fileName)).length
  const translationChunkCount = entries.filter((fileName) => /^translation_chunk_\d{3}_\d{3}\.txt$/.test(fileName)).length

  return translationPartCount > 0
    && translationPartCount === transcriptionPartCount
    && translationChunkCount > 0
    && translationChunkCount === transcriptionChunkCount
}

async function translateChunkToSpanish({
  chunkText,
  sourceLanguage,
}: {
  chunkText: string
  sourceLanguage?: string
}): Promise<string> {
  return completeOllamaResponse({
    system: [
      'Sos un traductor profesional de transcripciones.',
      'Traducí al español claro el fragmento recibido.',
      'No resumas, no expliques, no agregues contenido y no omitas detalles.',
      'Conservá timestamps si existen.',
      'Conservá etiquetas de hablante si existen.',
      'Traducí solo el contenido hablado.',
      'Mantené consistencia terminológica.',
      'Conservá siglas técnicas conocidas cuando convenga.',
      'No agregues prefacios como "Aquí está la traducción".',
      'Devolvé solamente la traducción.',
    ].join('\n'),
    prompt: [
      `Idioma fuente detectado o inferido: ${sourceLanguage ?? 'desconocido'}.`,
      'Traducí al español el siguiente fragmento de transcripción:',
      '',
      chunkText,
    ].join('\n'),
    maxContinuations: 2,
    profile: {
      numCtx: appConfig.fullNotesOllamaNumCtx,
      numPredict: appConfig.fullNotesOllamaNumPredict,
      keepAlive: appConfig.ollamaKeepAlive,
    },
    responseFormat: 'text',
    debugLabel: 'translation_chunk_to_spanish',
  })
}

async function ensureTranslatedChunk({
  chunk,
  sourceLanguage,
  log,
}: {
  chunk: TranscriptionChunkArtifact
  sourceLanguage?: string
  log: (message: string) => Promise<void>
}): Promise<void> {
  const tempTranslationPath = `${chunk.translationPath}.tmp`

  if (await isValidTranslationChunk(chunk.translationPath)) {
    await log(`Reutilizando chunk traducido existente ${path.basename(chunk.translationPath)}.`)
    return
  }

  if (await pathExists(tempTranslationPath)) {
    await fs.unlink(tempTranslationPath).catch(() => undefined)
    await log(`Descartando chunk temporal incompleto ${path.basename(tempTranslationPath)} antes de retraducir.`)
  }

  await log(`Traduciendo chunk ${path.basename(chunk.transcriptionPath)} al español.`)
  const translated = (await translateChunkToSpanish({
    chunkText: chunk.text,
    sourceLanguage,
  })).trim()

  if (!translated) {
    throw new Error(`Empty translation chunk: ${path.basename(chunk.translationPath)}`)
  }

  await writeTextAtomic(chunk.translationPath, `${translated}\n`)
  await log(`Chunk traducido guardado en ${path.basename(chunk.translationPath)}.`)
}

async function consolidateTranslationParts(
  outputDir: string,
  chunks: TranscriptionChunkArtifact[],
): Promise<string[]> {
  const grouped = new Map<string, TranscriptionChunkArtifact[]>()

  for (const chunk of chunks) {
    const existing = grouped.get(chunk.partId) ?? []
    existing.push(chunk)
    grouped.set(chunk.partId, existing)
  }

  const partIds = [...grouped.keys()].sort((left, right) => left.localeCompare(right))
  const partPaths: string[] = []

  for (const partId of partIds) {
    const partChunks = (grouped.get(partId) ?? []).sort((left, right) => left.chunkOrder - right.chunkOrder)
    const translatedChunks = await Promise.all(partChunks.map(async (chunk) => {
      const translatedText = (await readText(chunk.translationPath)).trim()
      if (!translatedText) {
        throw new Error(`Chunk traducido vacío durante consolidación: ${path.basename(chunk.translationPath)}`)
      }
      return translatedText
    }))

    const partPath = path.join(outputDir, `translation_part_${partId}.txt`)
    await writeTextAtomic(partPath, `${translatedChunks.join('\n\n').trim()}\n`)
    partPaths.push(partPath)
  }

  return partPaths
}

async function consolidateGlobalTranslation(partPaths: string[], outputDir: string): Promise<string> {
  const translatedParts = await Promise.all(partPaths.map(async (partPath) => {
    const partText = (await readText(partPath)).trim()
    if (!partText) {
      throw new Error(`Parte traducida vacía durante consolidación global: ${path.basename(partPath)}`)
    }
    return partText
  }))

  const translationPath = path.join(outputDir, 'translation_es.txt')
  await writeTextAtomic(translationPath, `${translatedParts.join('\n\n').trim()}\n`)
  return translationPath
}

export async function translateToSpanish({
  outputDir,
  sourceLanguage,
  log,
}: {
  outputDir: string
  sourceLanguage?: string
  log: (message: string) => Promise<void>
}): Promise<void> {
  const chunks = await collectTranscriptionChunks(outputDir)
  if (chunks.length === 0) {
    throw new Error('No hay transcription_chunk_* disponibles para traducir al español por chunks.')
  }

  await log(`Se traducirá la transcripción por chunks (${chunks.length} fragmentos) al español.`)

  for (const chunk of chunks) {
    await ensureTranslatedChunk({
      chunk,
      sourceLanguage,
      log,
    })
  }

  await log('Consolidando partes traducidas al español.')
  const partPaths = await consolidateTranslationParts(outputDir, chunks)
  await log(`Partes traducidas consolidadas: ${partPaths.length}.`)
  const translationPath = await consolidateGlobalTranslation(partPaths, outputDir)
  await log(`Traducción global al español consolidada en ${translationPath}.`)
}

async function ensureSpanishReadableText(
  job: JobRecord,
  transcriptionPath: string,
  log: (message: string) => Promise<void>,
  hooks: Pick<ProcessJobHooks, 'updateStatus' | 'refreshFiles'>,
): Promise<SpanishOutputResolution> {
  const outputLanguage = normalizeLanguageLabel(job.outputLanguage)
  const translationPath = path.join(job.outputDir, 'translation_es.txt')
  const transcription = await readText(transcriptionPath)

  const forcedTranscriptionLanguage = normalizeLanguageLabel(job.transcriptionLanguage)
  const detectedSourceLanguage = forcedTranscriptionLanguage && forcedTranscriptionLanguage !== 'auto'
    ? forcedTranscriptionLanguage
    : detectSourceLanguageFromTranscription(transcription)

  await log(`Idioma fuente detectado/inferido para la transcripción: ${detectedSourceLanguage}.`)

  if (outputLanguage !== 'es' && outputLanguage !== 'espanol' && outputLanguage !== 'spanish') {
    await log(`No se genera traducción porque outputLanguage=${job.outputLanguage}.`)
    return {
      detectedSourceLanguage,
      translationStatus: 'skipped',
      spanishTextPath: transcriptionPath,
    }
  }

  if (!job.generateTranslation) {
    await log('La salida de traducción está desactivada. Se conserva la transcripción original sin generar translation_es.txt.')
    return {
      detectedSourceLanguage,
      translationStatus: 'skipped',
      spanishTextPath: transcriptionPath,
    }
  }

  if (isSpanishLanguage(detectedSourceLanguage)) {
    if (await isValidArtifact(translationPath)) {
      await log(`Reutilizando artifact español ya existente en ${translationPath}.`)
      return {
        detectedSourceLanguage,
        translationStatus: 'reused_spanish_transcription',
        spanishTextPath: translationPath,
      }
    }
    await log('La transcripción ya está en español. Se reutiliza como artifact final en español.')
    await writeTextAtomic(translationPath, `${transcription.trim()}\n`)
    await hooks.refreshFiles()
    return {
      detectedSourceLanguage,
      translationStatus: 'reused_spanish_transcription',
      spanishTextPath: translationPath,
    }
  }

  await hooks.updateStatus('translating')
  if (await hasReusableTranslatedArtifacts(job.outputDir)) {
    await log(`Reutilizando traducción al español ya existente en ${translationPath}.`)
    return {
      detectedSourceLanguage,
      translationStatus: 'translated_to_spanish',
      spanishTextPath: translationPath,
    }
  }
  if (await isValidArtifact(translationPath)) {
    await log('Existe translation_es.txt, pero faltan artifacts chunked/part necesarios para reusar el estudio en español. Se regenerará la traducción por chunks.')
  }
  await log(`La transcripción no está en español (${detectedSourceLanguage}). Se traduce al español con Ollama.`)
  await translateToSpanish({
    outputDir: job.outputDir,
    sourceLanguage: detectedSourceLanguage,
    log,
  })
  await hooks.refreshFiles()
  await log(`Traducción al español guardada en ${translationPath}.`)
  return {
    detectedSourceLanguage,
    translationStatus: 'translated_to_spanish',
    spanishTextPath: translationPath,
  }
}

async function transcribeVideoParts({
  job,
  videoParts,
  log,
  signal,
}: {
  job: JobRecord;
  videoParts: string[];
  log: (message: string) => Promise<void>;
  signal?: AbortSignal;
}): Promise<StudyPart[]> {
  const parts: StudyPart[] = [];

  for (let index = 0; index < videoParts.length; index += 1) {
    const partNumber = index + 1;
    const audioPath = videoParts[index];
    const partId = formatPartId(partNumber);
    const transcriptionPath = path.join(job.outputDir, `transcription_part_${partId}.txt`);
    const extractionPath = path.join(job.outputDir, `extraction_part_${partId}.txt`);
    const segmentDir = path.join(job.outputDir, 'transcription_chunks', `part_${partId}`);
    const audioSegments = await segmentPartForTranscription(segmentDir, audioPath, `la parte ${partId}`, log, signal);
    const chunkMetadata: ChunkManifestChunk[] = [];

    if (await isValidArtifact(transcriptionPath)) {
      await log(`Reutilizando transcripción ya existente para la parte ${partId}.`);
      for (let segmentIndex = 0; segmentIndex < audioSegments.length; segmentIndex += 1) {
        const chunkOrder = segmentIndex + 1;
        const chunkTextPath = path.join(job.outputDir, `transcription_chunk_${partId}_${String(chunkOrder).padStart(3, '0')}.txt`);
        const chunkText = (await readText(chunkTextPath).catch(() => '')).trim();
        if (!chunkText) continue;

        chunkMetadata.push(annotateChunkSpeakerAwareness({
          chunk: {
          chunkId: formatChunkId(partNumber, chunkOrder),
          part: partId,
          order: chunkOrder,
          audioPath: audioSegments[segmentIndex],
          transcriptionPath: chunkTextPath,
          text: chunkText,
          startSeconds: segmentIndex * appConfig.whisperChunkDurationSeconds,
          endSeconds: (segmentIndex + 1) * appConfig.whisperChunkDurationSeconds,
          },
          speakerCountHint: job.speakerCountHint,
        }));
      }

      const awarenessLog = buildSpeakerAwarenessLogLine(chunkMetadata);
      if (awarenessLog) {
        await log(`${awarenessLog} Parte ${partId}.`);
      }

      parts.push({ partNumber, audioPath, transcriptionPath, extractionPath, chunks: chunkMetadata });
      continue;
    }

    const mergedChunks: string[] = [];

    for (let segmentIndex = 0; segmentIndex < audioSegments.length; segmentIndex += 1) {
      const segmentPath = audioSegments[segmentIndex];
      const chunkOrder = segmentIndex + 1;
      const outputBase = path.join(job.outputDir, `transcription_chunk_${partId}_${String(chunkOrder).padStart(3, '0')}`);
      await log(
        `Transcribiendo subchunk ${segmentIndex + 1}/${audioSegments.length} de la parte ${partId}: ${path.basename(segmentPath)}`,
      );

      const chunkTranscriptionPath = await transcribeAudio({
        audioPath: segmentPath,
        outputBase,
        language: job.transcriptionLanguage,
        onLog: log,
        signal,
      });

      const chunkContent = (await readText(chunkTranscriptionPath)).trim();
      if (chunkContent) {
        mergedChunks.push(chunkContent);
        chunkMetadata.push(annotateChunkSpeakerAwareness({
          chunk: {
          chunkId: formatChunkId(partNumber, chunkOrder),
          part: partId,
          order: chunkOrder,
          audioPath: segmentPath,
          transcriptionPath: chunkTranscriptionPath,
          text: chunkContent,
          startSeconds: segmentIndex * appConfig.whisperChunkDurationSeconds,
          endSeconds: (segmentIndex + 1) * appConfig.whisperChunkDurationSeconds,
          },
          speakerCountHint: job.speakerCountHint,
        }));
      }
    }

    const awarenessLog = buildSpeakerAwarenessLogLine(chunkMetadata);
    if (awarenessLog) {
      await log(`${awarenessLog} Parte ${partId}.`);
    }

    const mergedPartTranscription = `${mergedChunks.join('\n\n').trim()}\n`;
    const cleanedPartTranscription = postprocessTranscription(mergedPartTranscription);
    await writeText(transcriptionPath, cleanedPartTranscription);
    await log(`Transcripción parcial guardada en ${transcriptionPath}.`);
    parts.push({ partNumber, audioPath, transcriptionPath, extractionPath, chunks: chunkMetadata });
  }

  return parts;
}

async function generateStudyOutputs(
  jobId: string,
  outputDir: string,
  transcriptionPath: string,
  log: (message: string) => Promise<void>,
  recordStageSnapshot: (stage: string, metadata?: Record<string, unknown>) => Promise<void>,
  refreshFiles: () => Promise<void>,
  speakerCountHint?: number,
  signal?: AbortSignal,
): Promise<{ completedWithWarnings: boolean }> {
  const fullStudyNotesPath = path.join(outputDir, 'full_study_notes_es.txt');
  const summaryPath = path.join(outputDir, 'summary_es.txt');
  const legacySummaryPath = path.join(outputDir, 'legacy_summary_es.txt');
  const outlinePath = path.join(outputDir, 'outline_es.txt');
  const keyConceptsPath = path.join(outputDir, 'key_concepts_es.txt');
  const questionsPath = path.join(outputDir, 'questions_es.txt');
  const glossaryPath = path.join(outputDir, 'glossary_es.txt');
  const validationReportPath = path.join(outputDir, 'validation_report.json');
  const groundingReportPath = path.join(outputDir, 'grounding_report.json');
  const chunkManifestPath = path.join(outputDir, 'chunk_manifest.json');

  const allGlobalArtifactsExist = await Promise.all([
    isValidArtifact(fullStudyNotesPath),
    isValidArtifact(summaryPath),
    isValidArtifact(legacySummaryPath),
    isValidArtifact(outlinePath),
    isValidArtifact(keyConceptsPath),
    isValidArtifact(questionsPath),
    isValidArtifact(glossaryPath),
    isValidArtifact(validationReportPath),
    isValidArtifact(groundingReportPath),
    isValidArtifact(chunkManifestPath),
  ]);

  if (allGlobalArtifactsExist.every(Boolean)) {
    await log('Reutilizando material de estudio global ya generado.');
    return { completedWithWarnings: false };
  }

  const studyParts = await collectStudyParts(outputDir, speakerCountHint);
  throwIfCancelled(signal)

  if (studyParts.length === 0) {
    throw new Error('No hay transcripciones parciales para generar el material de estudio.');
  }

  const partExtractions: string[] = [];
  const validationParts: ValidationReportPart[] = [];
  const shortSummaries: string[] = [];
  const groundingInputs: GroundingPartInput[] = [];
  const fullNotesStartedAt = Date.now();

  for (const part of studyParts) {
    const partTranscription = await readText(part.transcriptionPath);
    await log(`Generando extracción exhaustiva grounded para la parte ${String(part.partNumber).padStart(3, '0')} con Ollama.`);
    await recordStageSnapshot('full_notes:start', { part: String(part.partNumber).padStart(3, '0') });

    const extractionResult = await generateExtractionForPart({
      transcription: partTranscription,
      chunks: part.chunks,
      partNumber: part.partNumber,
      observer: {
        log,
        snapshot: recordStageSnapshot,
        writeArtifact: async (fileName: string, content: string) => {
          const artifactPath = path.join(outputDir, fileName)
          await writeText(artifactPath, content)
          await refreshFiles()
          return artifactPath
        },
      },
    });
    throwIfCancelled(signal)

    validationParts.push(extractionResult.validation);

    if (extractionResult.validation.status === 'accepted_with_warnings') {
      await log(
        `Advertencias en la parte ${String(part.partNumber).padStart(3, '0')}: ${extractionResult.validation.decisionReason}`,
      );
    }

    if (extractionResult.validation.status === 'repaired') {
      await log(`La extracción de la parte ${String(part.partNumber).padStart(3, '0')} fue reparada tras detectar deriva fuerte.`);
    }

    if (!extractionResult.citationIntegrity.ok) {
      await log(
        `Integridad de citas fallida en la parte ${String(part.partNumber).padStart(3, '0')}: inválidas ${extractionResult.citationIntegrity.invalidCitationIds.length}, mal formadas ${extractionResult.citationIntegrity.malformedCitations.length}, claims sin cita ${extractionResult.citationIntegrity.claimsWithoutCitation.length}.`,
      );
    }

    await writeText(part.extractionPath, extractionResult.content);
    partExtractions.push(extractionResult.content);
    groundingInputs.push({
      partNumber: part.partNumber,
      groundedWindows: extractionResult.groundedWindows,
      evidencePack: extractionResult.evidencePack,
      citationIntegrity: extractionResult.citationIntegrity,
      citationRepairAttempts: extractionResult.citationRepairAttempts,
      coverage: extractionResult.coverage,
      windowReports: extractionResult.windowReports,
    });
    shortSummaries.push(extractionResult.shortSummary);

    if (extractionResult.validation.status === 'failed') {
      await log(
        `La validación legacy marcó la parte ${String(part.partNumber).padStart(3, '0')} como fallida, pero el job sigue para priorizar grounding por claims.`,
      );
    }
  }

  const fullStudyNotes = consolidateExtractions(partExtractions);

  await writeText(fullStudyNotesPath, fullStudyNotes);
  await writeText(legacySummaryPath, fullStudyNotes);
  await writeText(summaryPath, `${shortSummaries.map((item) => item.trim()).filter(Boolean).join('\n\n').trim()}\n`);
  await writeJson(validationReportPath, { parts: validationParts });
  const fullNotesDurationMs = Date.now() - fullNotesStartedAt;
  const groundingStartedAt = Date.now();
  await log(
    `Perfil Ollama grounding: num_ctx=${appConfig.groundingOllamaNumCtx}, num_predict=${appConfig.groundingOllamaNumPredict}, embed_model=${appConfig.groundingOllamaEmbedModel}.`,
  );
  await recordStageSnapshot('grounding:start');
  const groundingReport = await generateGroundingArtifacts({
    jobId,
    outputDir,
    studyParts,
    parts: groundingInputs,
    log,
    signal,
    observer: {
      log,
      snapshot: recordStageSnapshot,
      writeArtifact: async (fileName: string, content: string) => {
        const artifactPath = path.join(outputDir, fileName)
        await writeText(artifactPath, content)
        await refreshFiles()
        return artifactPath
      },
    },
  });
  await recordStageSnapshot('grounding:end');
  groundingReport.performanceSummary = await buildGroundingPerformanceSummary({
    outputDir,
    fullNotesDurationMs,
    groundingDurationMs: Date.now() - groundingStartedAt,
    report: groundingReport,
  });
  await writeJson(groundingReportPath, groundingReport);

  await log(`Material de estudio consolidado guardado en ${fullStudyNotesPath}.`);

  await recordStageSnapshot('full_notes:artifacts:start');
  const partsWithContent = await Promise.all(
    studyParts.map(async (part) => ({
      partNumber: part.partNumber,
      content: await readText(part.extractionPath),
    })),
  );

  await writeText(outlinePath, generateOutline(partsWithContent));
  await writeText(keyConceptsPath, generateKeyConcepts(partsWithContent));
  await writeText(questionsPath, generateStudyQuestions(partsWithContent));
  await writeText(glossaryPath, generateGlossary(partsWithContent));
  await recordStageSnapshot('full_notes:artifacts:end');

  if (!(await isValidArtifact(transcriptionPath))) {
    throw new Error(`La transcripción consolidada esperada no es válida: ${transcriptionPath}`);
  }

  const completedWithWarnings = groundingInputs.some((part) =>
    part.windowReports.some((window) => window.finalStatus === 'needs_review'),
  ) || validationParts.some((part) => part.status !== 'accepted')

  return { completedWithWarnings }
}

async function buildGroundingPerformanceSummary({
  outputDir,
  fullNotesDurationMs,
  groundingDurationMs,
  report,
}: {
  outputDir: string
  fullNotesDurationMs: number
  groundingDurationMs: number
  report: { parts: Array<{ metrics: { unsupportedClaimCount: number }; windowsTooCompressed: number }> }
}): Promise<GroundingPerformanceSummary> {
  const resourceStagesPath = path.join(outputDir, 'resource_stages.jsonl')
  const raw = await readText(resourceStagesPath).catch(() => '')
  const snapshots = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          processRssMb?: number
          systemUsedApproxMb?: number
        }
      } catch {
        return null
      }
    })
    .filter((value): value is { processRssMb?: number; systemUsedApproxMb?: number } => Boolean(value))

  const ramPeakTrackedMb = snapshots.reduce((max, snapshot) => Math.max(max, snapshot.processRssMb ?? 0), 0)
  const ramPeakSystemApproxMb = snapshots.reduce((max, snapshot) => Math.max(max, snapshot.systemUsedApproxMb ?? 0), 0)

  return {
    ramPeakTrackedMb,
    ramPeakSystemApproxMb: ramPeakSystemApproxMb > 0 ? ramPeakSystemApproxMb : undefined,
    fullNotesDurationMs,
    groundingDurationMs,
    unsupportedClaimCount: report.parts.reduce((sum, part) => sum + part.metrics.unsupportedClaimCount, 0),
    windowsTooCompressed: report.parts.reduce(
      (sum, part) => sum + part.windowsTooCompressed,
      0,
    ),
  }
}

async function collectStudyParts(outputDir: string, speakerCountHint?: number): Promise<StudyPart[]> {
  const entries = await fs.readdir(outputDir);
  const hasTranslatedParts = entries.some((fileName) => /^translation_part_\d{3}\.txt$/.test(fileName))
  const parts = await Promise.all(entries
    .map(async (fileName) => {
      const match = fileName.match(
        hasTranslatedParts
          ? /^translation_part_(\d{3})\.txt$/
          : /^transcription_part_(\d{3})\.txt$/,
      );
      if (!match?.[1]) {
        return null;
      }

      const partNumber = Number(match[1]);
      const audioPath = path.join(outputDir, 'video_parts', `part_${match[1]}.wav`);
      const chunkDir = path.join(outputDir, 'transcription_chunks', `part_${match[1]}`);
      const chunkAudioPaths = (await fs.readdir(chunkDir).catch(() => []))
        .filter((entry) => entry.endsWith('.wav'))
        .sort((a, b) => a.localeCompare(b))
        .map((entry) => path.join(chunkDir, entry));
      const chunks: ChunkManifestChunk[] = [];

      for (let index = 0; index < chunkAudioPaths.length; index += 1) {
        const chunkOrder = index + 1;
        const chunkBaseName = hasTranslatedParts
          ? `translation_chunk_${match[1]}_${String(chunkOrder).padStart(3, '0')}.txt`
          : `transcription_chunk_${match[1]}_${String(chunkOrder).padStart(3, '0')}.txt`
        const transcriptionChunkPath = path.join(
          outputDir,
          chunkBaseName,
        );
        const text = (await readText(transcriptionChunkPath).catch(() => '')).trim();
        if (!text) continue

        chunks.push(annotateChunkSpeakerAwareness({
          chunk: {
          chunkId: formatChunkId(partNumber, chunkOrder),
          part: match[1],
          order: chunkOrder,
          audioPath: chunkAudioPaths[index],
          transcriptionPath: transcriptionChunkPath,
          text,
          startSeconds: index * appConfig.whisperChunkDurationSeconds,
          endSeconds: (index + 1) * appConfig.whisperChunkDurationSeconds,
          },
          speakerCountHint,
        }));
      }

      return {
        partNumber,
        audioPath,
        transcriptionPath: path.join(outputDir, fileName),
        extractionPath: path.join(outputDir, `extraction_part_${match[1]}.txt`),
        chunks,
      } satisfies StudyPart;
    }));
  const validParts = parts
    .filter((value): value is StudyPart => Boolean(value))
    .sort((a, b) => a.partNumber - b.partNumber);

  return validParts;
}

async function isValidArtifact(filePath: string): Promise<boolean> {
  if (!(await pathExists(filePath))) {
    return false;
  }

  const stats = await fs.stat(filePath).catch(() => null);
  if (!stats || stats.size === 0) {
    return false;
  }

  if (/\.(txt|md|json)$/i.test(filePath)) {
    const content = await readText(filePath).catch(() => '');
    return content.trim().length >= MIN_VALID_ARTIFACT_LENGTH;
  }

  return stats.size >= MIN_VALID_ARTIFACT_LENGTH;
}

export async function hydrateJobFiles(job: JobRecord): Promise<JobRecord> {
  job.files = await listJobFiles(job.id, job.outputDir);
  job.updatedAt = new Date().toISOString();
  return job;
}
