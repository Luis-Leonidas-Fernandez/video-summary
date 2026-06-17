import fs from 'node:fs';
import { appConfig } from '../config.js';
import type { SystemDependencyStatus, SystemDiagnosticsResponse } from '../types.js';
import { checkCommandAvailable } from '../utils/shell.js';

function createDependencyStatus(status: SystemDependencyStatus): SystemDependencyStatus {
  return status;
}

async function checkExecutableDependency({
  key,
  label,
  expected,
  resolvedValue,
  resolutionHint,
}: {
  key: string;
  label: string;
  expected: string;
  resolvedValue: string;
  resolutionHint?: string;
}): Promise<SystemDependencyStatus> {
  const ok = await checkCommandAvailable(resolvedValue);
  return createDependencyStatus({
    key,
    label,
    kind: 'command',
    ok,
    expected,
    resolvedValue,
    detail: ok ? `${label} disponible.` : `${label} no está disponible en este entorno.`,
    resolutionHint,
  });
}

function checkFileDependency({
  key,
  label,
  expected,
  resolvedValue,
  resolutionHint,
}: {
  key: string;
  label: string;
  expected: string;
  resolvedValue: string;
  resolutionHint?: string;
}): SystemDependencyStatus {
  const ok = Boolean(resolvedValue) && fs.existsSync(resolvedValue);
  return createDependencyStatus({
    key,
    label,
    kind: 'file',
    ok,
    expected,
    resolvedValue,
    detail: ok ? `${label} encontrado.` : `${label} no existe en la ruta configurada.`,
    resolutionHint,
  });
}

function checkConfigDependency({
  key,
  label,
  expected,
  resolvedValue,
  ok,
  detail,
  resolutionHint,
}: {
  key: string;
  label: string;
  expected: string;
  resolvedValue?: string;
  ok: boolean;
  detail: string;
  resolutionHint?: string;
}): SystemDependencyStatus {
  return createDependencyStatus({
    key,
    label,
    kind: 'config',
    ok,
    expected,
    resolvedValue,
    detail,
    resolutionHint,
  });
}

export async function getSystemDiagnostics(): Promise<SystemDiagnosticsResponse> {
  const dependencies: SystemDependencyStatus[] = [
    await checkExecutableDependency({
      key: 'ollama',
      label: 'Ollama',
      expected: 'Comando `ollama` instalable por PATH',
      resolvedValue: 'ollama',
      resolutionHint: 'Instalá Ollama y verificá que `ollama` esté disponible para la app.',
    }),
    await checkExecutableDependency({
      key: 'ffmpeg',
      label: 'FFmpeg',
      expected: 'Comando `ffmpeg` instalable por PATH',
      resolvedValue: 'ffmpeg',
      resolutionHint: 'Instalá ffmpeg para descargar, limpiar audio y particionar video.',
    }),
    await checkExecutableDependency({
      key: 'yt_dlp',
      label: 'yt-dlp',
      expected: 'Comando `yt-dlp` instalable por PATH',
      resolvedValue: 'yt-dlp',
      resolutionHint: 'Instalá yt-dlp para resolver URLs y bajar audio de YouTube.',
    }),
    await checkExecutableDependency({
      key: 'whisper_cpp_binary',
      label: 'Whisper binary',
      expected: 'Binario `whisper-cli` o ruta configurada ejecutable',
      resolvedValue: appConfig.whisperCppBinary,
      resolutionHint: 'Configurá WHISPER_CPP_BINARY o instalá whisper.cpp para transcribir localmente.',
    }),
    await checkExecutableDependency({
      key: 'grounding_python',
      label: 'Python grounding',
      expected: 'Python ejecutable configurado para el worker de grounding',
      resolvedValue: appConfig.groundingPythonBin,
      resolutionHint: 'Instalá Python y las dependencias del grounding worker.',
    }),
    checkFileDependency({
      key: 'whisper_model',
      label: 'Whisper model',
      expected: 'Archivo GGML configurado en WHISPER_CPP_MODEL_PATH',
      resolvedValue: appConfig.whisperCppModelPath,
      resolutionHint: 'Definí WHISPER_CPP_MODEL_PATH apuntando al modelo Whisper que querés usar.',
    }),
    checkFileDependency({
      key: 'grounding_worker',
      label: 'Grounding worker',
      expected: 'Archivo Python del worker de grounding',
      resolvedValue: appConfig.groundingWorkerPath,
      resolutionHint: 'Verificá que el worker Python exista dentro de backend/grounding_worker.',
    }),
  ];

  if (!appConfig.whisperCppModelPath) {
    dependencies.push(checkConfigDependency({
      key: 'whisper_model_config',
      label: 'Whisper model path',
      expected: 'Configurar WHISPER_CPP_MODEL_PATH',
      ok: false,
      detail: 'WHISPER_CPP_MODEL_PATH está vacío; la transcripción va a fallar aunque whisper-cli exista.',
      resolutionHint: 'Completá backend/.env con la ruta real del modelo Whisper.',
    }));
  }

  return {
    appMode: process.env.VIDEO_STUDY_DESKTOP === 'true' ? 'desktop' : 'web',
    allRequiredAvailable: dependencies.every((dependency) => dependency.ok),
    generatedAt: new Date().toISOString(),
    dependencies,
  };
}
