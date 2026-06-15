import { useMemo, useState, type FormEvent } from 'react';
import type { CreateJobPayload } from '../api';

type InputMode = 'single_url' | 'url_list' | 'playlist';

interface JobFormProps {
  isSubmitting: boolean;
  onSubmit: (payload: CreateJobPayload) => Promise<void>;
}

interface JobFormState {
  inputMode: InputMode;
  url: string;
  urlsText: string;
  playlistUrl: string;
  transcriptionLanguage: string;
  outputLanguage: string;
  generateTranscription: boolean;
  generateTranslation: boolean;
  generateSummary: boolean;
  speakerCountHint?: number;
}

const initialState: JobFormState = {
  inputMode: 'single_url',
  url: '',
  urlsText: '',
  playlistUrl: '',
  transcriptionLanguage: 'auto',
  outputLanguage: 'es',
  generateTranscription: true,
  generateTranslation: true,
  generateSummary: true,
  speakerCountHint: 3,
};

function buildPayload(form: JobFormState): CreateJobPayload {
  const base = {
    transcriptionLanguage: form.transcriptionLanguage,
    outputLanguage: form.outputLanguage,
    generateTranscription: form.generateTranscription,
    generateTranslation: form.generateTranslation,
    generateSummary: form.generateSummary,
    speakerCountHint: form.speakerCountHint,
  };

  if (form.inputMode === 'single_url') {
    return {
      ...base,
      url: form.url.trim(),
    };
  }

  if (form.inputMode === 'playlist') {
    return {
      ...base,
      playlistUrl: form.playlistUrl.trim(),
    };
  }

  return {
    ...base,
    urls: form.urlsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

export function JobForm({ isSubmitting, onSubmit }: JobFormProps) {
  const [form, setForm] = useState<JobFormState>(initialState);

  const submitLabel = useMemo(() => {
    switch (form.inputMode) {
      case 'playlist':
        return isSubmitting ? 'Creando lote...' : 'Procesar playlist';
      case 'url_list':
        return isSubmitting ? 'Creando lote...' : 'Procesar lote';
      default:
        return isSubmitting ? 'Encolando procesamiento...' : 'Procesar video';
    }
  }, [form.inputMode, isSubmitting]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit(buildPayload(form));
  };

  return (
    <form onSubmit={handleSubmit} className="panel form-panel">
      <div className="panel-header panel-header-top">
        <div>
          <p className="eyebrow">Primary workflow</p>
          <h2>Nuevo procesamiento</h2>
          <p className="panel-caption">Elegí si querés un video único, una lista manual o una playlist. El pipeline interno sigue aislando cada item.</p>
        </div>
      </div>

      <fieldset className="form-card-fieldset">
        <legend>Modo de entrada</legend>
        <div className="option-grid option-grid-three">
          <label className="option-card">
            <input
              type="radio"
              name="inputMode"
              checked={form.inputMode === 'single_url'}
              onChange={() => setForm((current) => ({ ...current, inputMode: 'single_url' }))}
            />
            <div>
              <strong>Video único</strong>
              <p>El flujo clásico. Ideal para piezas largas o para reprocesar una sola fuente.</p>
            </div>
          </label>

          <label className="option-card">
            <input
              type="radio"
              name="inputMode"
              checked={form.inputMode === 'url_list'}
              onChange={() => setForm((current) => ({ ...current, inputMode: 'url_list' }))}
            />
            <div>
              <strong>Lista manual</strong>
              <p>Una URL por línea. El backend deduplica y procesa secuencialmente hasta el límite del lote.</p>
            </div>
          </label>

          <label className="option-card">
            <input
              type="radio"
              name="inputMode"
              checked={form.inputMode === 'playlist'}
              onChange={() => setForm((current) => ({ ...current, inputMode: 'playlist' }))}
            />
            <div>
              <strong>Playlist</strong>
              <p>Primero resuelve videos con yt-dlp y recién después arma los items del lote.</p>
            </div>
          </label>
        </div>
      </fieldset>

      <div className="form-section-grid">
        {form.inputMode === 'single_url' ? (
          <label className="field-block field-block-full">
            <span className="field-label">URL de YouTube</span>
            <input
              type="url"
              value={form.url}
              onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))}
              placeholder="https://www.youtube.com/watch?v=..."
              required
            />
            <span className="field-help">Este es el punto de entrada del pipeline completo: descarga, transcripción, grounding y material final.</span>
          </label>
        ) : null}

        {form.inputMode === 'url_list' ? (
          <label className="field-block field-block-full">
            <span className="field-label">Lista de URLs</span>
            <textarea
              value={form.urlsText}
              onChange={(event) => setForm((current) => ({ ...current, urlsText: event.target.value }))}
              placeholder={['https://www.youtube.com/watch?v=abc123', 'https://www.youtube.com/watch?v=def456'].join('\n')}
              rows={6}
              required
            />
            <span className="field-help">Pegá una URL por línea. El lote se deduplica por URL normalizada y aplica solo a jobs futuros.</span>
          </label>
        ) : null}

        {form.inputMode === 'playlist' ? (
          <label className="field-block field-block-full">
            <span className="field-label">URL de playlist</span>
            <input
              type="url"
              value={form.playlistUrl}
              onChange={(event) => setForm((current) => ({ ...current, playlistUrl: event.target.value }))}
              placeholder="https://www.youtube.com/playlist?list=..."
              required
            />
            <span className="field-help">La expansión se resuelve en segundo plano. Si la playlist supera el límite v1, el job falla con error claro.</span>
          </label>
        ) : null}

        <label className="field-block">
          <span className="field-label">Idioma del audio (recomendado: auto)</span>
          <input
            type="text"
            list="language-options"
            value={form.transcriptionLanguage}
            onChange={(event) =>
              setForm((current) => ({ ...current, transcriptionLanguage: event.target.value }))
            }
            placeholder="auto, en, es, English, Spanish..."
            required
          />
          <span className="field-help">Usá <code>auto</code> para detección automática o forzá un idioma concreto si sabés cómo viene el audio.</span>
          <datalist id="language-options">
            <option value="auto" />
            <option value="en" />
            <option value="es" />
            <option value="ja" />
            <option value="English" />
            <option value="Spanish" />
            <option value="Japanese" />
          </datalist>
        </label>

        <label className="field-block">
          <span className="field-label">Idioma final de salida</span>
          <input
            type="text"
            value={form.outputLanguage}
            onChange={(event) =>
              setForm((current) => ({ ...current, outputLanguage: event.target.value }))
            }
            placeholder="es"
            required
          />
          <span className="field-help">Por defecto se genera salida en español. Si el video ya está en español, se reutiliza la transcripción.</span>
        </label>

        <label className="field-block">
          <span className="field-label">Cantidad posible de speakers</span>
          <input
            type="number"
            min={1}
            max={12}
            value={form.speakerCountHint ?? ''}
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                speakerCountHint: event.target.value === '' ? undefined : Number(event.target.value),
              }))
            }
          />
          <span className="field-help">Sirve como hint para detectar chunks con voces solapadas y bajar confianza cuando se pisan.</span>
        </label>
      </div>

      <fieldset className="form-card-fieldset">
        <legend>Salidas que querés priorizar</legend>
        <div className="option-grid">
          <label className="option-card">
            <input
              type="checkbox"
              checked={form.generateTranscription}
              onChange={(event) =>
                setForm((current) => ({ ...current, generateTranscription: event.target.checked }))
              }
            />
            <div>
              <strong>Transcripción original</strong>
              <p>Genera la base textual cruda del video o de cada item del lote.</p>
            </div>
          </label>

          <label className="option-card">
            <input
              type="checkbox"
              checked={form.generateTranslation}
              onChange={(event) =>
                setForm((current) => ({ ...current, generateTranslation: event.target.checked }))
              }
            />
            <div>
              <strong>Traducción al español</strong>
              <p>Si el video no está en español, genera `translation_es.txt`. Si ya está en español, reutiliza la transcripción.</p>
            </div>
          </label>

          <label className="option-card">
            <input
              type="checkbox"
              checked={form.generateSummary}
              onChange={(event) =>
                setForm((current) => ({ ...current, generateSummary: event.target.checked }))
              }
            />
            <div>
              <strong>Material de estudio</strong>
              <p>Activa notes, grounding y evaluación semántica del resultado final.</p>
            </div>
          </label>
        </div>
      </fieldset>

      <div className="form-footer">
        <p className="panel-caption">El modelo LLM se toma desde el runtime superior. Cambiarlo afecta solo jobs futuros, incluso en lotes.</p>
        <button type="submit" disabled={isSubmitting} className="primary-button">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
