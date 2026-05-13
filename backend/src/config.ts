import fs from 'node:fs';
import path from 'node:path';

const envFilePath = path.resolve(process.cwd(), '.env');

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(envFilePath);

const defaultGroundingVenvPython = path.resolve(
  process.cwd(),
  'grounding_worker',
  '.venv',
  'bin',
  'python3',
);

const defaultGroundingPythonBin = fs.existsSync(defaultGroundingVenvPython)
  ? defaultGroundingVenvPython
  : '/opt/homebrew/bin/python3';

const emittedLegacyConfigWarnings = new Set<string>()

function warnLegacyConfig(message: string): void {
  if (emittedLegacyConfigWarnings.has(message)) {
    return
  }

  emittedLegacyConfigWarnings.add(message)
  console.warn(message)
}

function resolveStageScopedNumber({
  stageEnvKey,
  legacyEnvKey,
  defaultValue,
}: {
  stageEnvKey: string
  legacyEnvKey: string
  defaultValue: number
}): number {
  const stageValue = process.env[stageEnvKey]
  if (stageValue != null && stageValue !== '') {
    return Number(stageValue)
  }

  const legacyValue = process.env[legacyEnvKey]
  if (legacyValue != null && legacyValue !== '') {
    warnLegacyConfig(`[config] ${stageEnvKey} no definido; usando ${legacyEnvKey} como fallback.`)
    return Number(legacyValue)
  }

  return defaultValue
}

export const appConfig = {
  port: Number(process.env.PORT ?? 3001),
  whisperCppBinary: process.env.WHISPER_CPP_BINARY ?? 'whisper-cli',
  whisperCppModelPath: process.env.WHISPER_CPP_MODEL_PATH ?? '',
  whisperCppThreads: Number(process.env.WHISPER_CPP_THREADS ?? 10),
  videoPartDurationSeconds: Number(process.env.VIDEO_PART_DURATION_SECONDS ?? 1800),
  whisperChunkDurationSeconds: Number(process.env.WHISPER_CHUNK_DURATION_SECONDS ?? 90),
  whisperCppGlossary:
    process.env.WHISPER_CPP_GLOSSARY ??
    'Japan, Yusuke, Taro, Kenji, karoshi, futoko, ijime, juku, shukatsu, naitei, ronin, konbini, pachinko, onigiri, Aokigahara',
  whisperDenoiseFilter:
    process.env.WHISPER_DENOISE_FILTER ?? 'afftdn=nr=20:nf=-20:tn=1,highpass=f=120,lowpass=f=7000',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
  defaultOllamaModel: process.env.OLLAMA_MODEL ?? 'gemma3:12b',
  ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS ?? 3600000),
  ollamaNumParallel: Number(process.env.OLLAMA_NUM_PARALLEL ?? 1),
  ollamaMaxLoadedModels: Number(process.env.OLLAMA_MAX_LOADED_MODELS ?? 1),
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE ?? '2m',
  ollamaIdleShutdownMs: Number(process.env.OLLAMA_IDLE_SHUTDOWN_MS ?? 30000),
  fullNotesOllamaNumPredict: resolveStageScopedNumber({
    stageEnvKey: 'FULL_NOTES_OLLAMA_NUM_PREDICT',
    legacyEnvKey: 'OLLAMA_NUM_PREDICT',
    defaultValue: 1500,
  }),
  fullNotesOllamaNumCtx: resolveStageScopedNumber({
    stageEnvKey: 'FULL_NOTES_OLLAMA_NUM_CTX',
    legacyEnvKey: 'OLLAMA_NUM_CTX',
    defaultValue: 4096,
  }),
  groundingOllamaNumPredict: resolveStageScopedNumber({
    stageEnvKey: 'GROUNDING_OLLAMA_NUM_PREDICT',
    legacyEnvKey: 'OLLAMA_NUM_PREDICT',
    defaultValue: 700,
  }),
  groundingOllamaNumCtx: resolveStageScopedNumber({
    stageEnvKey: 'GROUNDING_OLLAMA_NUM_CTX',
    legacyEnvKey: 'OLLAMA_NUM_CTX',
    defaultValue: 4096,
  }),
  groundingMode: process.env.GROUNDING_MODE ?? 'auto',
  groundingPythonBin: process.env.GROUNDING_PYTHON_BIN ?? defaultGroundingPythonBin,
  groundingWorkerPath:
    process.env.GROUNDING_WORKER_PATH ??
    path.resolve(process.cwd(), 'grounding_worker', 'grounding_worker.py'),
  groundingOllamaEmbedModel: process.env.GROUNDING_OLLAMA_EMBED_MODEL ?? 'embeddinggemma',
  groundingTopK: Number(process.env.GROUNDING_TOP_K ?? 5),
  groundingMaxCharsPerChunk: Number(process.env.GROUNDING_MAX_CHARS_PER_CHUNK ?? 1200),
  groundingMaxTotalEvidenceChars: Number(process.env.GROUNDING_MAX_TOTAL_EVIDENCE_CHARS ?? 6000),
  groundingSupportedThreshold: Number(process.env.GROUNDING_SUPPORTED_THRESHOLD ?? 0.8),
  groundingWeakThreshold: Number(process.env.GROUNDING_WEAK_THRESHOLD ?? 0.6),
  exhaustiveWindowSizeChunks: Number(process.env.EXHAUSTIVE_WINDOW_SIZE_CHUNKS ?? 4),
  exhaustiveWindowOverlapChunks: Number(process.env.EXHAUSTIVE_WINDOW_OVERLAP_CHUNKS ?? 1),
  minNoteBlocksPerWindow: Number(process.env.MIN_NOTE_BLOCKS_PER_WINDOW ?? 2),
  minWordsPerWindowExtraction: Number(process.env.MIN_WORDS_PER_WINDOW_EXTRACTION ?? 350),
  minExhaustiveWordRatio: Number(process.env.MIN_EXHAUSTIVE_WORD_RATIO ?? 0.70),
  minExhaustiveChunkCoverageRatio: Number(process.env.MIN_EXHAUSTIVE_CHUNK_COVERAGE_RATIO ?? 0.9),
  maxJsonContractRepairAttempts: Number(process.env.MAX_JSON_CONTRACT_REPAIR_ATTEMPTS ?? 1),
  maxStrictReemitAttempts: Number(process.env.MAX_STRICT_REEMIT_ATTEMPTS ?? 1),
  generationSchemaMode: process.env.GENERATION_SCHEMA_MODE ?? 'simple_draft',
  enableTwoStepRecoveryForGeneration: (process.env.ENABLE_TWO_STEP_RECOVERY_FOR_GENERATION ?? 'true') !== 'false',
  maxTwoStepRecoveryAttempts: Number(process.env.MAX_TWO_STEP_RECOVERY_ATTEMPTS ?? 1),
  enableSemanticEnrichment: (process.env.ENABLE_SEMANTIC_ENRICHMENT ?? 'false') === 'true',
  maxSemanticEnrichmentAttempts: Number(process.env.MAX_SEMANTIC_ENRICHMENT_ATTEMPTS ?? 1),
  enableChainSemanticEnrichment: (process.env.ENABLE_CHAIN_SEMANTIC_ENRICHMENT ?? 'true') !== 'false',
  maxChainSemanticEnrichmentAttempts: Number(process.env.MAX_CHAIN_SEMANTIC_ENRICHMENT_ATTEMPTS ?? 1),
  enableThinReasoningChain: (process.env.ENABLE_THIN_REASONING_CHAIN ?? 'true') !== 'false',
  enableClosureSanitizer: (process.env.ENABLE_CLOSURE_SANITIZER ?? 'true') !== 'false',
  fallbackMode: process.env.FALLBACK_MODE ?? 'editorial',
};
