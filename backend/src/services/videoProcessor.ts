import path from 'node:path';
import { promises as fs } from 'node:fs';
import { appConfig } from '../config.js';
import {
  consolidateExtractions,
  generateExtractionForPart,
  type ValidationReportPart,
} from './studyExtraction.js';
import {
  generateGlossary,
  generateKeyConcepts,
  generateOutline,
  generateStudyQuestions,
} from './studyArtifacts.js';
import { postprocessTranscription } from './transcriptionPostprocessor.js';
import { partitionVideoAudio } from './videoPartitioner.js';
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
const MIN_VALID_ARTIFACT_LENGTH = 40;

interface StudyPart {
  partNumber: number;
  audioPath: string;
  transcriptionPath: string;
  extractionPath: string;
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
      await log(`Generando material de estudio exhaustivo con Ollama (${appConfig.ollamaModel}).`);
      await generateStudyOutputs(job.outputDir, transcriptionPath, log);
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
): Promise<string> {
  await hooks.updateStatus('transcribing');
  const denoisedAudioPath = await denoiseAudio(job, audioPath, log);
  const videoParts = await partitionVideoAudio({
    outputDir: job.outputDir,
    inputAudioPath: denoisedAudioPath,
    log,
  });
  const languageLabel =
    job.language.trim().toLowerCase() === 'auto' || job.language.trim() === ''
      ? 'detección automática de idioma'
      : `idioma forzado: ${job.language.trim()}`;
  await log(`Transcribiendo audio con whisper.cpp (${languageLabel}) usando modelo ${path.basename(appConfig.whisperCppModelPath)}.`);

  const transcriptionPath = path.join(job.outputDir, 'transcription.txt');
  const studyParts = await transcribeVideoParts({
    job,
    videoParts,
    log,
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

async function transcribeVideoParts({
  job,
  videoParts,
  log,
}: {
  job: JobRecord;
  videoParts: string[];
  log: (message: string) => Promise<void>;
}): Promise<StudyPart[]> {
  const parts: StudyPart[] = [];

  for (let index = 0; index < videoParts.length; index += 1) {
    const partNumber = index + 1;
    const audioPath = videoParts[index];
    const partId = String(partNumber).padStart(3, '0');
    const transcriptionPath = path.join(job.outputDir, `transcription_part_${partId}.txt`);
    const extractionPath = path.join(job.outputDir, `extraction_part_${partId}.txt`);

    if (await isValidArtifact(transcriptionPath)) {
      await log(`Reutilizando transcripción ya existente para la parte ${partId}.`);
      parts.push({ partNumber, audioPath, transcriptionPath, extractionPath });
      continue;
    }

    const segmentDir = path.join(job.outputDir, 'transcription_chunks', `part_${partId}`);
    const audioSegments = await segmentPartForTranscription(segmentDir, audioPath, `la parte ${partId}`, log);
    const mergedChunks: string[] = [];

    for (let segmentIndex = 0; segmentIndex < audioSegments.length; segmentIndex += 1) {
      const segmentPath = audioSegments[segmentIndex];
      const outputBase = path.join(job.outputDir, `transcription_chunk_${partId}_${String(segmentIndex + 1).padStart(3, '0')}`);
      await log(
        `Transcribiendo subchunk ${segmentIndex + 1}/${audioSegments.length} de la parte ${partId}: ${path.basename(segmentPath)}`,
      );

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

    const mergedPartTranscription = `${mergedChunks.join('\n\n').trim()}\n`;
    const cleanedPartTranscription = postprocessTranscription(mergedPartTranscription);
    await writeText(transcriptionPath, cleanedPartTranscription);
    await log(`Transcripción parcial guardada en ${transcriptionPath}.`);
    parts.push({ partNumber, audioPath, transcriptionPath, extractionPath });
  }

  return parts;
}

async function generateStudyOutputs(
  outputDir: string,
  transcriptionPath: string,
  log: (message: string) => Promise<void>,
): Promise<void> {
  const fullStudyNotesPath = path.join(outputDir, 'full_study_notes_es.txt');
  const summaryCompatibilityPath = path.join(outputDir, 'summary_es.txt');
  const outlinePath = path.join(outputDir, 'outline_es.txt');
  const keyConceptsPath = path.join(outputDir, 'key_concepts_es.txt');
  const questionsPath = path.join(outputDir, 'questions_es.txt');
  const glossaryPath = path.join(outputDir, 'glossary_es.txt');
  const validationReportPath = path.join(outputDir, 'validation_report.json');

  const allGlobalArtifactsExist = await Promise.all([
    isValidArtifact(fullStudyNotesPath),
    isValidArtifact(summaryCompatibilityPath),
    isValidArtifact(outlinePath),
    isValidArtifact(keyConceptsPath),
    isValidArtifact(questionsPath),
    isValidArtifact(glossaryPath),
    isValidArtifact(validationReportPath),
  ]);

  if (allGlobalArtifactsExist.every(Boolean)) {
    await log('Reutilizando material de estudio global ya generado.');
    return;
  }

  const studyParts = await collectStudyParts(outputDir);

  if (studyParts.length === 0) {
    throw new Error('No hay transcripciones parciales para generar el material de estudio.');
  }

  const partExtractions: string[] = [];
  const validationParts: ValidationReportPart[] = [];

  for (const part of studyParts) {
    const partTranscription = await readText(part.transcriptionPath);
    const existingExtraction = (await isValidArtifact(part.extractionPath))
      ? await readText(part.extractionPath)
      : undefined;

    if (existingExtraction) {
      await log(`Validando extracción exhaustiva ya existente para la parte ${String(part.partNumber).padStart(3, '0')}.`);
    } else {
      await log(`Generando extracción exhaustiva para la parte ${String(part.partNumber).padStart(3, '0')} con Ollama.`);
    }

    const extractionResult = await generateExtractionForPart({
      transcription: partTranscription,
      partNumber: part.partNumber,
      existingExtraction,
    });

    validationParts.push(extractionResult.validation);

    if (extractionResult.validation.status === 'failed') {
      await writeJson(validationReportPath, { parts: validationParts });
      throw new Error(
        `La extracción de la parte ${String(part.partNumber).padStart(3, '0')} quedó inválida después de la reparación automática.`,
      );
    }

    if (extractionResult.validation.status === 'accepted_with_warnings') {
      await log(
        `Advertencias en la parte ${String(part.partNumber).padStart(3, '0')}: ${extractionResult.validation.decisionReason}`,
      );
    }

    if (extractionResult.validation.status === 'repaired') {
      await log(`La extracción de la parte ${String(part.partNumber).padStart(3, '0')} fue reparada tras detectar deriva fuerte.`);
    }

    await writeText(part.extractionPath, extractionResult.content);
    partExtractions.push(extractionResult.content);
  }

  const fullStudyNotes = consolidateExtractions(partExtractions);

  await writeText(fullStudyNotesPath, fullStudyNotes);
  await writeText(summaryCompatibilityPath, fullStudyNotes);
  await writeJson(validationReportPath, { parts: validationParts });
  await log(`Material de estudio consolidado guardado en ${fullStudyNotesPath}.`);

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

  if (!(await isValidArtifact(transcriptionPath))) {
    throw new Error(`La transcripción consolidada esperada no es válida: ${transcriptionPath}`);
  }
}

async function collectStudyParts(outputDir: string): Promise<StudyPart[]> {
  const entries = await fs.readdir(outputDir);
  const parts = entries
    .map((fileName) => {
      const match = fileName.match(/^transcription_part_(\d{3})\.txt$/);
      if (!match?.[1]) {
        return null;
      }

      const partNumber = Number(match[1]);
      const audioPath = path.join(outputDir, 'video_parts', `part_${match[1]}.wav`);
      return {
        partNumber,
        audioPath,
        transcriptionPath: path.join(outputDir, fileName),
        extractionPath: path.join(outputDir, `extraction_part_${match[1]}.txt`),
      } satisfies StudyPart;
    })
    .filter((value): value is StudyPart => Boolean(value))
    .sort((a, b) => a.partNumber - b.partNumber);

  return parts;
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
