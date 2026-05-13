import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  getModelSelection,
  updateModelSelection,
  type HealthResponse,
  type LocalModelInfo,
  type ModelSelectionResponse,
} from '../api';

interface AiRuntimeBannerProps {
  health: HealthResponse | null;
  error: string | null;
  onRefreshHealth: () => Promise<void>;
}

const HEAVY_MODEL_SIZE_BYTES = 8 * 1024 * 1024 * 1024;

function formatBytes(bytes?: number): string | null {
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes <= 0) {
    return null;
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getRuntimeMessage(health: HealthResponse | null): string {
  if (!health) {
    return 'Cargando estado del runtime de IA...';
  }

  switch (health.aiRuntime) {
    case 'starting':
      return `IA iniciando con ${health.ollamaModel}...`;
    case 'busy':
      return `IA procesando con ${health.ollamaModel}...`;
    case 'idle':
      if (!health.ownedByCurrentSession && !health.nextShutdownAt) {
        return `IA en espera sobre un runtime externo. Modelo activo: ${health.ollamaModel}.`;
      }
      return `IA en descanso con ${health.ollamaModel}. Se apagará automáticamente si no hay nuevas tareas.`;
    case 'offline':
      return `IA apagada. El próximo job que use ${health.ollamaModel} la va a levantar on-demand.`;
    case 'stopping':
      return `IA apagándose para liberar memoria después de usar ${health.ollamaModel}...`;
    case 'error':
      return `La IA tuvo un problema al iniciar o apagarse con ${health.ollamaModel}. Revisá los logs del backend.`;
    case 'ready':
      return `IA lista con ${health.ollamaModel}.`;
    default:
      return 'Estado de IA desconocido.';
  }
}

function findSelectedModel(selection: ModelSelectionResponse | null): LocalModelInfo | null {
  if (!selection) {
    return null;
  }

  return selection.availableModels.find((item) => item.name === selection.activeModel) ?? null;
}

export function AiRuntimeBanner({ health, error, onRefreshHealth }: AiRuntimeBannerProps) {
  const [selection, setSelection] = useState<ModelSelectionResponse | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [isSelectionLoading, setIsSelectionLoading] = useState(false);
  const [isSavingSelection, setIsSavingSelection] = useState(false);

  const message = error
    ? `No se pudo consultar el runtime de IA: ${error}`
    : getRuntimeMessage(health);

  const selectedModelInfo = useMemo(() => findSelectedModel(selection), [selection]);
  const heavyModelWarning = selectedModelInfo?.size && selectedModelInfo.size >= HEAVY_MODEL_SIZE_BYTES
    ? `Este modelo puede consumir mucha memoria en tu Mac (${formatBytes(selectedModelInfo.size)}). El cambio aplica solo a jobs futuros.`
    : null;

  const refreshSelection = async () => {
    setIsSelectionLoading(true);
    try {
      const nextSelection = await getModelSelection();
      setSelection(nextSelection);
      setSelectionError(null);
    } catch (nextError) {
      setSelectionError(nextError instanceof Error ? nextError.message : 'No se pudo cargar la selección de modelo.');
    } finally {
      setIsSelectionLoading(false);
    }
  };

  useEffect(() => {
    void refreshSelection();
  }, []);

  useEffect(() => {
    if (!health || !selection) {
      return;
    }

    if (selection.activeModel !== health.ollamaModel) {
      void refreshSelection();
    }
  }, [health, selection]);

  const handleModelChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextModel = event.target.value;
    if (!nextModel || nextModel === selection?.activeModel) {
      return;
    }

    setIsSavingSelection(true);
    setSelectionError(null);

    try {
      const updated = await updateModelSelection(nextModel);
      setSelection(updated);
      await onRefreshHealth();
    } catch (nextError) {
      setSelectionError(nextError instanceof Error ? nextError.message : 'No se pudo actualizar el modelo activo.');
    } finally {
      setIsSavingSelection(false);
    }
  };

  return (
    <section className="panel ai-runtime-panel">
      <div className="panel-header">
        <h2>Runtime de IA</h2>
        {health ? <span className={`status-pill status-${health.aiRuntime}`}>{health.aiRuntime}</span> : null}
      </div>
      <p className="panel-caption">{message}</p>
      {health ? (
        <div className="status-grid">
          <div>
            <strong>Modelo</strong>
            <p>{health.ollamaModel}</p>
          </div>
          <div>
            <strong>Jobs IA activos</strong>
            <p>{health.activeJobsCount}</p>
          </div>
          <div>
            <strong>Ownership</strong>
            <p>{health.ownedByCurrentSession ? 'Esta sesión controla Ollama' : 'Runtime externo o apagado'}</p>
          </div>
          <div>
            <strong>Idle shutdown</strong>
            <p>{Math.round(health.idleShutdownMs / 60000)} min</p>
          </div>
          {health.lastActivityAt ? (
            <div>
              <strong>Última actividad</strong>
              <p>{new Date(health.lastActivityAt).toLocaleString()}</p>
            </div>
          ) : null}
          {health.nextShutdownAt ? (
            <div>
              <strong>Próximo apagado</strong>
              <p>{new Date(health.nextShutdownAt).toLocaleString()}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="model-selection-box">
        <div className="model-selection-header">
          <div>
            <strong>Modelo LLM principal</strong>
            <p className="panel-caption">
              Cambia el modelo global para jobs futuros. No toca embeddings ni Whisper.
            </p>
          </div>
        </div>

        <label>
          <span className="field-label">Seleccioná un modelo local de Ollama</span>
          <select
            value={selection?.activeModel ?? ''}
            onChange={handleModelChange}
            disabled={isSelectionLoading || isSavingSelection || !selection}
          >
            <option value="" disabled>
              {isSelectionLoading ? 'Cargando modelos...' : 'Elegí un modelo'}
            </option>
            {(selection?.availableModels ?? [])
              .filter((item) => item.selectable)
              .map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}{item.size ? ` · ${formatBytes(item.size)}` : ''}
                </option>
              ))}
          </select>
        </label>

        {selection ? (
          <div className="model-selection-meta">
            <span>Fuente: {selection.source === 'runtime_state' ? 'selección persistida' : 'default del .env'}</span>
            {!selection.activeModelAvailable ? <span>Modelo activo no verificado ahora mismo.</span> : null}
          </div>
        ) : null}

        {selection?.warning ? <p className="runtime-warning">{selection.warning}</p> : null}
        {selectionError ? <p className="runtime-warning runtime-warning-error">{selectionError}</p> : null}
        {heavyModelWarning ? <p className="runtime-warning runtime-warning-caution">{heavyModelWarning}</p> : null}
      </div>
    </section>
  );
}
