import type { JobFile, ValidationReport } from '../api';
import { resolveApiUrl } from '../desktop';

interface ValidationSummaryProps {
  report: ValidationReport | null;
  files: JobFile[];
  isLoading: boolean;
}

function getStatusLabel(status: ValidationReport['parts'][number]['status']): string {
  switch (status) {
    case 'accepted':
      return 'OK';
    case 'accepted_with_warnings':
      return 'Con advertencias';
    case 'repaired':
      return 'Reparada';
    case 'failed':
      return 'Fallida';
    default:
      return status;
  }
}

function getStatusClassName(status: ValidationReport['parts'][number]['status']): string {
  return `validation-pill validation-${status}`;
}

function findFile(files: JobFile[], name: string): JobFile | undefined {
  return files.find((file) => file.filename === name || file.name === name || file.relativePath === name);
}

function shouldShowNormalizedLabel(label: string, normalizedLabel: string): boolean {
  return normalizedLabel.trim().length > 0 && normalizedLabel !== label.toLowerCase().trim();
}

export function ValidationSummary({ report, files, isLoading }: ValidationSummaryProps) {
  if (isLoading && !report) {
    return (
      <section className="panel legacy-panel">
        <h2>Señales de revisión (legacy)</h2>
        <p>Cargando estado de validación...</p>
      </section>
    );
  }

  if (!report || report.parts.length === 0) {
    return null;
  }

  const warningCount = report.parts.filter((part) => part.status !== 'accepted').length;

  return (
    <section className="panel legacy-panel">
      <div className="panel-header panel-header-top">
        <div>
          <p className="eyebrow">Fallback legacy</p>
          <h2>Señales de revisión</h2>
          <p className="panel-caption">Este bloque queda disponible como backup cuando no hay grounding por claims suficiente.</p>
        </div>
        <span className="status-pill subtle-pill">{warningCount} partes con señales</span>
      </div>

      <details className="disclosure-card">
        <summary>Ver validación legacy completa</summary>
        <div className="disclosure-content validation-list">
          {report.parts.map((part) => {
            const transcriptionFile = findFile(files, `transcription_part_${part.part}.txt`);
            const extractionFile = findFile(files, `extraction_part_${part.part}.txt`);
            const hasSignals = part.status === 'repaired' || part.status === 'accepted_with_warnings' || part.status === 'failed';

            return (
              <article key={part.part} className="validation-card validation-card-secondary">
                <div className="validation-card-header">
                  <div>
                    <h3>Parte {part.part}</h3>
                    <p className="validation-meta">
                      Intentos de reparación: {part.repairAttempts}
                    </p>
                  </div>
                  <span className={getStatusClassName(part.status)}>{getStatusLabel(part.status)}</span>
                </div>

                <p className="validation-meta">{part.decisionReason}</p>
                <p className="validation-meta">
                  Headings: {part.metrics.headingCount} · Unmatched: {part.metrics.unmatchedCount} (
                  {Math.round(part.metrics.unmatchedRatio * 100)}%) · Match semántico:{' '}
                  {Math.round(part.metrics.semanticMatchRatio * 100)}%
                </p>

                {hasSignals ? (
                  <ul className="validation-details">
                    {part.warnings.map((warning) => (
                      <li key={`warning-${part.part}-${warning}`}>Advertencia: {warning}</li>
                    ))}
                    {part.strongFlags.map((flag) => (
                      <li key={`flag-${part.part}-${flag}`}>Señal fuerte: {flag}</li>
                    ))}
                    {part.matches
                      .filter((match) => match.matchType === 'unmatched' || match.matchType === 'semantic_heading_match')
                      .slice(0, 4)
                      .map((match) => (
                        <li key={`match-${part.part}-${match.label}-${match.matchType}`}>
                          {match.label}
                          {shouldShowNormalizedLabel(match.label, match.normalizedLabel) ? ` (${match.normalizedLabel})` : ''}: {match.reason}
                        </li>
                      ))}
                  </ul>
                ) : (
                  <p className="validation-ok">Sin señales fuertes para esta parte.</p>
                )}

                <div className="validation-links">
                  {transcriptionFile ? (
                    <a href={resolveApiUrl(transcriptionFile.downloadUrl)} target="_blank" rel="noreferrer">
                      Ver transcripción
                    </a>
                  ) : null}
                  {extractionFile ? (
                    <a href={resolveApiUrl(extractionFile.downloadUrl)} target="_blank" rel="noreferrer">
                      Ver extracción
                    </a>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </details>
    </section>
  );
}
