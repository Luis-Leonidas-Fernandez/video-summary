import path from 'node:path';
import { promises as fs } from 'node:fs';
import { appConfig } from '../config.js';
import type {
  LocalModelInfo,
  ModelSelectionResponse,
  ModelSelectionSource,
  JobModelMetadata,
} from '../types.js';

const runtimeDir = process.env.VIDEO_STUDY_RUNTIME_DIR
  ? path.resolve(process.env.VIDEO_STUDY_RUNTIME_DIR)
  : path.resolve(process.cwd(), '..', '.runtime');
const modelSelectionPath = path.join(runtimeDir, 'model-selection.json');
const OLLAMA_TAGS_URL = `${appConfig.ollamaBaseUrl}/api/tags`;
const OLLAMA_TAGS_TIMEOUT_MS = 4_000;

interface PersistedModelSelection {
  activeOllamaModel: string;
  updatedAt: string;
  updatedBy: 'frontend' | 'backend' | 'fallback';
  lastVerifiedAt?: string;
  ollamaBaseUrl: string;
}

interface OllamaTagModel {
  name?: string;
  digest?: string;
  size?: number;
  modified_at?: string;
  details?: {
    family?: string;
    families?: string[];
  };
}

interface OllamaTagsResponse {
  models?: OllamaTagModel[];
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .toLowerCase();
}

function isEmbeddingModel(name: string, details?: OllamaTagModel['details']): boolean {
  const haystack = normalize([
    name,
    details?.family ?? '',
    ...(details?.families ?? []),
  ].join(' '));

  return /\bembed\b|\bembedding\b|\bnomic-embed\b/.test(haystack);
}

function toLocalModelInfo(model: OllamaTagModel): LocalModelInfo | null {
  const name = model.name?.trim();
  if (!name) {
    return null;
  }

  const embedding = isEmbeddingModel(name, model.details);
  return {
    name,
    digest: model.digest,
    size: typeof model.size === 'number' ? model.size : undefined,
    modifiedAt: model.modified_at,
    family: embedding ? 'embedding' : ((model.details?.family || model.details?.families?.[0]) ? 'llm' : 'unknown'),
    selectable: !embedding,
    unselectableReason: embedding ? 'embedding_model' : undefined,
  };
}

async function ensureRuntimeDir(): Promise<void> {
  await fs.mkdir(runtimeDir, { recursive: true });
}

async function readPersistedSelection(): Promise<PersistedModelSelection | null> {
  try {
    const raw = await fs.readFile(modelSelectionPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedModelSelection>;
    if (
      typeof parsed.activeOllamaModel !== 'string'
      || typeof parsed.updatedAt !== 'string'
      || typeof parsed.updatedBy !== 'string'
      || typeof parsed.ollamaBaseUrl !== 'string'
    ) {
      return null;
    }
    return {
      activeOllamaModel: parsed.activeOllamaModel,
      updatedAt: parsed.updatedAt,
      updatedBy: parsed.updatedBy as PersistedModelSelection['updatedBy'],
      lastVerifiedAt: typeof parsed.lastVerifiedAt === 'string' ? parsed.lastVerifiedAt : undefined,
      ollamaBaseUrl: parsed.ollamaBaseUrl,
    };
  } catch {
    return null;
  }
}

async function writePersistedSelection(state: PersistedModelSelection): Promise<void> {
  await ensureRuntimeDir();
  await fs.writeFile(modelSelectionPath, JSON.stringify(state, null, 2), 'utf-8');
}

function buildSelectionResponse({
  activeModel,
  source,
  availableModels,
  warning,
  activeModelAvailableOverride,
}: {
  activeModel: string;
  source: ModelSelectionSource;
  availableModels: LocalModelInfo[];
  warning?: string;
  activeModelAvailableOverride?: boolean;
}): ModelSelectionResponse {
  return {
    activeModel,
    defaultModel: appConfig.defaultOllamaModel,
    source,
    activeModelAvailable: activeModelAvailableOverride ?? availableModels.some((item) => item.name === activeModel),
    availableModels,
    warning,
  };
}

class ModelSelectionService {
  private initialized = false;
  private currentSelection?: ModelSelectionResponse;

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.currentSelection = await this.resolveSelection({ healPersistedState: true });
    this.initialized = true;
  }

  async listLocalModels(): Promise<LocalModelInfo[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_TAGS_TIMEOUT_MS);

    try {
      const response = await fetch(OLLAMA_TAGS_URL, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Ollama respondió con HTTP ${response.status} al listar modelos.`);
      }

      const data = (await response.json()) as OllamaTagsResponse;
      return (data.models ?? [])
        .map(toLocalModelInfo)
        .filter((item): item is LocalModelInfo => Boolean(item))
        .sort((left, right) => left.name.localeCompare(right.name));
    } finally {
      clearTimeout(timeout);
    }
  }

  async getSelectionResponse(): Promise<ModelSelectionResponse> {
    await this.initialize();
    this.currentSelection = await this.resolveSelection({ healPersistedState: true });
    return this.currentSelection;
  }

  async getActiveModelState(): Promise<{
    activeModel: string;
    source: ModelSelectionSource;
    activeModelAvailable: boolean;
    warning?: string;
  }> {
    const selection = await this.getSelectionResponse();
    return {
      activeModel: selection.activeModel,
      source: selection.source,
      activeModelAvailable: selection.activeModelAvailable,
      warning: selection.warning,
    };
  }

  async getFrozenJobModelMetadata(): Promise<JobModelMetadata> {
    const state = await this.getActiveModelState();
    return {
      ollamaModelUsed: state.activeModel,
      modelSelectionSource: state.source,
    };
  }

  async setActiveModel(model: string, updatedBy: PersistedModelSelection['updatedBy']): Promise<ModelSelectionResponse> {
    const availableModels = await this.listLocalModels();
    const selected = availableModels.find((item) => item.name === model);

    if (!selected) {
      throw new Error(`El modelo ${model} no existe en Ollama local.`);
    }

    if (!selected.selectable) {
      throw new Error(`El modelo ${model} no es seleccionable como LLM principal.`);
    }

    const now = new Date().toISOString();
    await writePersistedSelection({
      activeOllamaModel: model,
      updatedAt: now,
      updatedBy,
      lastVerifiedAt: now,
      ollamaBaseUrl: appConfig.ollamaBaseUrl,
    });

    this.currentSelection = buildSelectionResponse({
      activeModel: model,
      source: 'runtime_state',
      availableModels,
      activeModelAvailableOverride: true,
    });
    this.initialized = true;
    return this.currentSelection;
  }

  private async resolveSelection({
    healPersistedState,
  }: {
    healPersistedState: boolean;
  }): Promise<ModelSelectionResponse> {
    let availableModels: LocalModelInfo[] = [];
    let tagsWarning: string | undefined;
    try {
      availableModels = await this.listLocalModels();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudieron consultar los modelos locales.';
      tagsWarning = `No se pudo verificar el catálogo de modelos en Ollama: ${message}`;
    }
    const persisted = await readPersistedSelection();
    const now = new Date().toISOString();

    if (persisted) {
      if (tagsWarning) {
        return buildSelectionResponse({
          activeModel: persisted.activeOllamaModel,
          source: 'runtime_state',
          availableModels,
          warning: tagsWarning,
          activeModelAvailableOverride: false,
        });
      }

      const persistedExists = availableModels.some((item) => item.name === persisted.activeOllamaModel);
      if (persistedExists) {
        if (healPersistedState) {
          await writePersistedSelection({
            ...persisted,
            lastVerifiedAt: now,
            ollamaBaseUrl: appConfig.ollamaBaseUrl,
          });
        }

        return buildSelectionResponse({
          activeModel: persisted.activeOllamaModel,
          source: 'runtime_state',
          availableModels,
          activeModelAvailableOverride: true,
        });
      }

      const defaultExists = availableModels.some((item) => item.name === appConfig.defaultOllamaModel);
      const warning = `El modelo persistido ${persisted.activeOllamaModel} ya no existe en Ollama local.`

      if (defaultExists) {
        if (healPersistedState) {
          await writePersistedSelection({
            activeOllamaModel: appConfig.defaultOllamaModel,
            updatedAt: now,
            updatedBy: 'fallback',
            lastVerifiedAt: now,
            ollamaBaseUrl: appConfig.ollamaBaseUrl,
          });
        }

        return buildSelectionResponse({
          activeModel: appConfig.defaultOllamaModel,
          source: 'env',
          availableModels,
          warning: `${warning} Se volvió al modelo por default del .env.`,
          activeModelAvailableOverride: true,
        });
      }

      return buildSelectionResponse({
        activeModel: appConfig.defaultOllamaModel,
        source: 'env',
        availableModels,
        warning: `${warning} Además, el default ${appConfig.defaultOllamaModel} tampoco está disponible.`,
      });
    }

    if (tagsWarning) {
      return buildSelectionResponse({
        activeModel: appConfig.defaultOllamaModel,
        source: 'env',
        availableModels,
        warning: tagsWarning,
        activeModelAvailableOverride: false,
      });
    }

    const defaultExists = availableModels.some((item) => item.name === appConfig.defaultOllamaModel);
    return buildSelectionResponse({
      activeModel: appConfig.defaultOllamaModel,
      source: 'env',
      availableModels,
      warning: defaultExists ? undefined : `El modelo por default ${appConfig.defaultOllamaModel} no está disponible en Ollama local.`,
      activeModelAvailableOverride: defaultExists,
    });
  }
}

export const modelSelectionService = new ModelSelectionService();
