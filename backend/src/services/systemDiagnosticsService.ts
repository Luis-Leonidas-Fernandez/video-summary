import fs from 'node:fs';
import { appConfig } from '../config.js';
import type { SystemDependencyStatus, SystemDiagnosticsResponse } from '../types.js';
import {
  formatSearchedPaths,
  getEffectiveBackendPath,
  resolveFfmpegExecutable,
  resolveOllamaExecutable,
  resolveYtDlpExecutable,
  type ExecutableResolution,
} from './executableResolutionService.js';
import { modelSelectionService } from './modelSelectionService.js';
import { checkCommandAvailable } from '../utils/shell.js';

function createDependencyStatus(status: SystemDependencyStatus): SystemDependencyStatus {
  return status;
}

function buildExecutableDependencyStatus({
  label,
  expected,
  resolutionHint,
  resolution,
}: {
  label: string;
  expected: string;
  resolutionHint?: string;
  resolution: ExecutableResolution;
}): SystemDependencyStatus {
  const ok = resolution.exists;
  const searchedPathsLabel = formatSearchedPaths(resolution.searchedPaths);
  return createDependencyStatus({
    key: resolution.key,
    label,
    kind: 'command',
    ok,
    configuredCommand: resolution.configuredCommand,
    expected,
    resolvedValue: resolution.resolvedPath,
    source: resolution.source,
    detail: ok
      ? `${label} disponible en ${resolution.resolvedPath} (${resolution.source}).`
      : `${label} no está disponible en este entorno desktop. PATH efectivo: ${getEffectiveBackendPath() || '(vacío)'}. Probado en: ${searchedPathsLabel}.`,
    resolutionHint: ok ? resolutionHint : `${resolutionHint ?? `Configurá ${label}.`} También podés fijar manualmente ${resolution.overrideEnvVar} con la ruta absoluta del binario.`,
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
    source: 'config',
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
    source: 'config',
    detail,
    resolutionHint,
  });
}

async function buildConfiguredCommandDependencyStatus({
  key,
  label,
  expected,
  configuredCommand,
  resolutionHint,
}: {
  key: string;
  label: string;
  expected: string;
  configuredCommand: string;
  resolutionHint?: string;
}): Promise<SystemDependencyStatus> {
  const ok = await checkCommandAvailable(configuredCommand);
  return createDependencyStatus({
    key,
    label,
    kind: 'command',
    ok,
    configuredCommand,
    expected,
    resolvedValue: ok ? configuredCommand : undefined,
    source: configuredCommand.includes('/') ? 'env' : (ok ? 'path' : 'missing'),
    detail: ok
      ? `${label} disponible en ${configuredCommand}.`
      : `${label} no está disponible con la configuración actual (${configuredCommand}).`,
    resolutionHint,
  });
}

export async function getSystemDiagnostics(): Promise<SystemDiagnosticsResponse> {
  const [ollamaResolution, ffmpegResolution, ytDlpResolution, catalogSnapshot, whisperBinaryStatus, groundingPythonStatus] = await Promise.all([
    resolveOllamaExecutable(),
    resolveFfmpegExecutable(),
    resolveYtDlpExecutable(),
    modelSelectionService.getCatalogSnapshot(),
    buildConfiguredCommandDependencyStatus({
      key: 'whisper_cpp_binary',
      label: 'Whisper binary',
      expected: 'Binario `whisper-cli` o ruta configurada ejecutable',
      configuredCommand: appConfig.whisperCppBinary,
      resolutionHint: 'Configurá WHISPER_CPP_BINARY o instalá whisper.cpp para transcribir localmente.',
    }),
    buildConfiguredCommandDependencyStatus({
      key: 'grounding_python',
      label: 'Python grounding',
      expected: 'Python ejecutable configurado para el worker de grounding',
      configuredCommand: appConfig.groundingPythonBin,
      resolutionHint: 'Instalá Python y las dependencias del grounding worker.',
    }),
  ]);

  const dependencies: SystemDependencyStatus[] = [
    buildExecutableDependencyStatus({
      label: 'Ollama',
      expected: 'Comando `ollama` instalable por PATH',
      resolution: ollamaResolution,
      resolutionHint: 'Instalá Ollama y verificá que `ollama` esté disponible para la app.',
    }),
    buildExecutableDependencyStatus({
      label: 'FFmpeg',
      expected: 'Comando `ffmpeg` instalable por PATH',
      resolution: ffmpegResolution,
      resolutionHint: 'Instalá ffmpeg para descargar, limpiar audio y particionar video.',
    }),
    buildExecutableDependencyStatus({
      label: 'yt-dlp',
      expected: 'Comando `yt-dlp` instalable por PATH',
      resolution: ytDlpResolution,
      resolutionHint: 'Instalá yt-dlp para resolver URLs y bajar audio de YouTube.',
    }),
    whisperBinaryStatus,
    groundingPythonStatus,
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
    backendPath: getEffectiveBackendPath(),
    ollamaBaseUrl: appConfig.ollamaBaseUrl,
    catalogReachable: catalogSnapshot.reachable,
    catalogModelCount: catalogSnapshot.availableModels.length,
    catalogModelNames: catalogSnapshot.modelNames,
    dependencies,
  };
}
