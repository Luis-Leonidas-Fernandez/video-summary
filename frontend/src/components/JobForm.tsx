import { useState, type FormEvent } from 'react';
import type { CreateJobPayload, JobLanguage } from '../api';

interface JobFormProps {
  isSubmitting: boolean;
  onSubmit: (payload: CreateJobPayload) => Promise<void>;
}

const initialState: CreateJobPayload = {
  url: '',
  language: 'auto',
  generateTranscription: true,
  generateTranslation: true,
  generateSummary: true,
};

export function JobForm({ isSubmitting, onSubmit }: JobFormProps) {
  const [form, setForm] = useState<CreateJobPayload>(initialState);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await onSubmit(form);
  };

  return (
    <form onSubmit={handleSubmit} className="panel form-panel">
      <h2>Nuevo procesamiento</h2>

      <label>
        URL de YouTube
        <input
          type="url"
          value={form.url}
          onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))}
          placeholder="https://www.youtube.com/watch?v=..."
          required
        />
      </label>

      <label>
        Idioma esperado
        <select
          value={form.language}
          onChange={(event) =>
            setForm((current) => ({ ...current, language: event.target.value as JobLanguage }))
          }
        >
          <option value="auto">auto</option>
          <option value="English">English</option>
          <option value="Spanish">Spanish</option>
        </select>
      </label>

      <fieldset>
        <legend>Archivos a generar</legend>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.generateTranscription}
            onChange={(event) =>
              setForm((current) => ({ ...current, generateTranscription: event.target.checked }))
            }
          />
          transcripción original
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.generateTranslation}
            onChange={(event) =>
              setForm((current) => ({ ...current, generateTranslation: event.target.checked }))
            }
          />
          traducción al español
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.generateSummary}
            onChange={(event) =>
              setForm((current) => ({ ...current, generateSummary: event.target.checked }))
            }
          />
          resumen en español
        </label>
      </fieldset>

      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Procesando...' : 'Procesar'}
      </button>
    </form>
  );
}
