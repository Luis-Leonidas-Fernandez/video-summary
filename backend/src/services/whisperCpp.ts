import { appConfig } from '../config.js';
import { pathExists } from '../utils/files.js';
import { checkCommandAvailable, runCommand } from '../utils/shell.js';
import type { JobLanguage } from '../types.js';

const LANGUAGE_NAME_TO_CODE: Record<string, string> = {
  english: 'en',
  ingles: 'en',
  inglish: 'en',
  spanish: 'es',
  espanol: 'es',
  español: 'es',
  french: 'fr',
  frances: 'fr',
  francés: 'fr',
  german: 'de',
  aleman: 'de',
  alemán: 'de',
  italian: 'it',
  italiano: 'it',
  portuguese: 'pt',
  portugues: 'pt',
  portugués: 'pt',
  chinese: 'zh',
  chino: 'zh',
  japanese: 'ja',
  japones: 'ja',
  japonés: 'ja',
  korean: 'ko',
  coreano: 'ko',
  russian: 'ru',
  ruso: 'ru',
};

function normalizeLanguageValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function resolveLanguageCode(language: string): string | null {
  const normalized = normalizeLanguageValue(language);
  if (!normalized || normalized === 'auto') return null;

  const mapped = LANGUAGE_NAME_TO_CODE[normalized];
  if (mapped) {
    return mapped;
  }

  if (/^[a-z]{2,5}$/.test(normalized)) {
    return normalized;
  }

  throw new Error(
    `Idioma no soportado para whisper.cpp: "${language}". Usá auto, un código como en/es/ja o un nombre simple como English/Spanish/Japanese.`,
  );
}

export async function validateWhisperCpp(): Promise<void> {
  const available = await checkCommandAvailable(appConfig.whisperCppBinary);
  if (!available) {
    throw new Error(
      `whisper-cli no está disponible (${appConfig.whisperCppBinary}). Configurá WHISPER_CPP_BINARY en .env con la ruta absoluta al binario.`,
    );
  }

  if (!appConfig.whisperCppModelPath) {
    throw new Error('WHISPER_CPP_MODEL_PATH no está configurado en .env');
  }

  if (!(await pathExists(appConfig.whisperCppModelPath))) {
    throw new Error(`Modelo whisper.cpp no encontrado: ${appConfig.whisperCppModelPath}`);
  }
}

export async function transcribeAudio({
  audioPath,
  outputBase,
  language,
  onLog,
  signal,
}: {
  audioPath: string;
  outputBase: string;
  language: JobLanguage;
  onLog: (line: string) => Promise<void>;
  signal?: AbortSignal;
}): Promise<string> {
  const transcriptionPath = `${outputBase}.txt`;

  const args = [
    '-m', appConfig.whisperCppModelPath,
    '-f', audioPath,
    '--output-txt',
    '--output-file', outputBase,
    '--threads', String(appConfig.whisperCppThreads),
    '--print-progress',
  ];

  if (appConfig.whisperCppGlossary.trim()) {
    args.push('--prompt', appConfig.whisperCppGlossary);
  }

  const langCode = resolveLanguageCode(language);
  if (langCode) {
    args.push('-l', langCode);
  }

  await runCommand({
    command: appConfig.whisperCppBinary,
    args,
    signal,
    onStdout: async (chunk) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        await onLog(`[whisper-cli] ${line}`);
      }
    },
    onStderr: async (chunk) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        await onLog(`[whisper-cli] ${line}`);
      }
    },
  });

  if (!(await pathExists(transcriptionPath))) {
    throw new Error('whisper-cli terminó sin generar transcription.txt.');
  }

  return transcriptionPath;
}
