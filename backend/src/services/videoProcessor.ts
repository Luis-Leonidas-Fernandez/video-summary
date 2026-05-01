import path from 'node:path';
import { promises as fs } from 'node:fs';
import { appConfig } from '../config.js';
import { generateSpanishSummary } from './ollamaClient.js';
import { postprocessTranscription } from './transcriptionPostprocessor.js';
import { transcribeAudio, validateWhisperCpp } from './whisperCpp.js';
import { appendLine, ensureDir, listJobFiles, pathExists, readText, writeJson, writeText } from '../utils/files.js';
import { checkCommandAvailable, runCommand } from '../utils/shell.js';
import type { JobRecord, JobStatus } from '../types.js';

interface ProcessJobHooks {
  updateStatus: (status: JobStatus) => Promise<void>;
  appendLog: (message: string) => Promise<void>;
  refreshFiles: () => Promise<void>;
  failJob: (message: string) => Promise<void>;
}

const REQUIRED_COMMANDS = ['yt-dlp', 'ffmpeg'] as const;

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

export async function processVideoJob(job: JobRecord, hooks: ProcessJobHooks): Promise<void> {
  await ensureDir(job.outputDir);
  const logFilePath = path.join(job.outputDir, 'logs.txt');

  const log = async (message: string): Promise<void> => {
    const timestamped = `[${new Date().toISOString()}] ${message}`;
    await hooks.appendLog(timestamped);
    await appendLine(logFilePath, timestamped);
  };

  const persistJobFile = async (): Promise<void> => {
    await writeJson(path.join(job.outputDir, 'job.json'), job);
  };

  try {
    await log('Iniciando validación de dependencias del sistema.');
    await validateDependencies();
    await persistJobFile();

    const audioPath = await downloadAudio(job, log, hooks);
    const transcriptionPath = await runTranscription(job, audioPath, log, hooks);

    if (!job.generateTranscription) {
      await log('La opción de transcripción original fue desactivada. Se mantiene el archivo porque traducción/resumen dependen de la transcripción en este MVP.');
    }

    if (job.generateTranslation) {
      await hooks.updateStatus('translating');
      await log('Generando placeholder de traducción al español.');
      await translateToSpanish(job.outputDir, transcriptionPath);
      await hooks.refreshFiles();
      await persistJobFile();
    }

    if (job.generateSummary) {
      await hooks.updateStatus('summarizing');
      await log(`Generando resumen con Ollama (${appConfig.ollamaModel}).`);
      await summarizeSpanish(job.outputDir, transcriptionPath);
      await hooks.refreshFiles();
      await persistJobFile();
    }

    await hooks.updateStatus('completed');
    await hooks.refreshFiles();
    await persistJobFile();
    await log('Trabajo completado correctamente.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido durante el procesamiento.';
    await log(`ERROR: ${message}`);
    await hooks.failJob(message);
    await persistJobFile();
    throw error;
  }
}

async function downloadAudio(
  job: JobRecord,
  log: (message: string) => Promise<void>,
  hooks: Pick<ProcessJobHooks, 'updateStatus' | 'refreshFiles'>,
): Promise<string> {
  await hooks.updateStatus('downloading');

  const outputTemplate = path.join(job.outputDir, 'audio.%(ext)s');
  await log(`Descargando audio desde: ${job.url}`);

  await runCommand({
    command: 'yt-dlp',
    args: ['-x', '--audio-format', 'mp3', '--no-playlist', '-o', outputTemplate, job.url],
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

  const audioPath = path.join(job.outputDir, 'audio.mp3');
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
): Promise<string> {
  const denoisedAudioPath = path.join(job.outputDir, 'audio_denoised.wav');

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

async function segmentAudioForTranscription(
  job: JobRecord,
  denoisedAudioPath: string,
  log: (message: string) => Promise<void>,
): Promise<string[]> {
  const segmentDir = path.join(job.outputDir, 'transcription_chunks');
  const segmentPattern = path.join(segmentDir, 'chunk_%03d.wav');

  await ensureDir(segmentDir);
  await log(
    `Segmentando audio para transcripción en bloques de ${appConfig.whisperChunkDurationSeconds} segundos.`,
  );

  await runCommand({
    command: 'ffmpeg',
    args: [
      '-y',
      '-i',
      denoisedAudioPath,
      '-f',
      'segment',
      '-segment_time',
      String(appConfig.whisperChunkDurationSeconds),
      '-c',
      'copy',
      segmentPattern,
    ],
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

  await log(`Audio segmentado en ${segments.length} chunks.`);
  return segments;
}

async function runTranscription(
  job: JobRecord,
  audioPath: string,
  log: (message: string) => Promise<void>,
  hooks: Pick<ProcessJobHooks, 'updateStatus' | 'refreshFiles'>,
): Promise<string> {
  await hooks.updateStatus('transcribing');
  const denoisedAudioPath = await denoiseAudio(job, audioPath, log);
  const audioSegments = await segmentAudioForTranscription(job, denoisedAudioPath, log);
  const languageLabel =
    job.language.trim().toLowerCase() === 'auto' || job.language.trim() === ''
      ? 'detección automática de idioma'
      : `idioma forzado: ${job.language.trim()}`;
  await log(`Transcribiendo audio con whisper.cpp (${languageLabel}) usando modelo ${path.basename(appConfig.whisperCppModelPath)}.`);

  const transcriptionPath = path.join(job.outputDir, 'transcription.txt');
  const mergedChunks: string[] = [];

  for (let index = 0; index < audioSegments.length; index += 1) {
    const segmentPath = audioSegments[index];
    const outputBase = path.join(job.outputDir, `transcription_chunk_${String(index + 1).padStart(3, '0')}`);
    await log(`Transcribiendo chunk ${index + 1}/${audioSegments.length}: ${path.basename(segmentPath)}`);

    const chunkTranscriptionPath = await transcribeAudio({
      audioPath: segmentPath,
      outputBase,
      language: job.language,
      onLog: log,
    });

    const chunkContent = (await readText(chunkTranscriptionPath)).trim();
    if (chunkContent) {
      mergedChunks.push(chunkContent);
    }
  }

  await log('Aplicando postproceso de transcripción para deduplicar repeticiones consecutivas.');
  const mergedTranscription = `${mergedChunks.join('\n\n').trim()}\n`;
  const cleanedTranscription = postprocessTranscription(mergedTranscription);
  await writeText(transcriptionPath, cleanedTranscription);

  await hooks.refreshFiles();
  await log(`Transcripción guardada en ${transcriptionPath}`);
  return transcriptionPath;
}

export async function translateToSpanish(outputDir: string, transcriptionPath: string): Promise<void> {
  const transcription = await readText(transcriptionPath);
  const content = [
    'PLACEHOLDER: traducción al español pendiente.',
    'Conectá esta función a Ollama o a una API LLM en una próxima versión.',
    '',
    'Vista previa del texto fuente:',
    transcription.slice(0, 2000),
  ].join('\n');

  await writeText(path.join(outputDir, 'translation_es.txt'), content);
}

export async function summarizeSpanish(outputDir: string, transcriptionPath: string): Promise<void> {
  const transcription = await readText(transcriptionPath);
  const summary = await generateSpanishSummary(transcription);
  await writeText(path.join(outputDir, 'summary_es.txt'), summary);
}

export async function hydrateJobFiles(job: JobRecord): Promise<JobRecord> {
  job.files = await listJobFiles(job.id, job.outputDir);
  job.updatedAt = new Date().toISOString();
  return job;
}
