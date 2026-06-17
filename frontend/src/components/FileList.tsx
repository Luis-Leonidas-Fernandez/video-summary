import type { JobFile } from '../api';
import { resolveApiUrl } from '../desktop';
import { sortAndCategorizeFiles, type ArtifactCategory } from '../presentation';

interface FileListProps {
  files: JobFile[];
  title?: string;
}

const CATEGORY_LABELS: Record<ArtifactCategory, string> = {
  reading: 'Lectura',
  report: 'Reportes',
  debug: 'Debug',
  raw: 'Raw',
  log: 'Logs',
};

const CATEGORY_DESCRIPTIONS: Record<ArtifactCategory, string> = {
  reading: 'Lo más útil para leer rápido el resultado final.',
  report: 'Reportes estructurados para auditar grounding, cobertura y recursos.',
  debug: 'Artifacts de análisis fino para troubleshooting o recovery.',
  raw: 'Salidas crudas o auxiliares del pipeline.',
  log: 'Eventos y trazas de ejecución.',
};

const PRIMARY_CATEGORIES: ArtifactCategory[] = ['reading', 'report'];
const SECONDARY_CATEGORIES: ArtifactCategory[] = ['log', 'debug', 'raw'];

function formatFileSize(size: number): string {
  const kb = Math.max(1, Math.round(size / 1024));
  if (kb < 1024) {
    return `${kb} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}

function getDisplayName(file: JobFile): string {
  return file.relativePath || file.filename || file.name;
}

function isWordDocument(file: JobFile): boolean {
  return getDisplayName(file).toLowerCase().endsWith('.docx');
}

function getDownloadHref(file: JobFile): string {
  return resolveApiUrl(file.downloadUrl);
}

export function FileList({ files, title = 'Archivos generados' }: FileListProps) {
  const sorted = sortAndCategorizeFiles(files);
  const grouped = sorted.reduce<Record<ArtifactCategory, typeof sorted>>((acc, file) => {
    acc[file.category].push(file);
    return acc;
  }, {
    reading: [],
    report: [],
    debug: [],
    raw: [],
    log: [],
  });

  return (
    <section className="panel files-panel">
      <div className="panel-header panel-header-top">
        <div>
          <p className="eyebrow">Artifacts útiles</p>
          <h2>{title}</h2>
          <p className="panel-caption">Primero lectura y reportes. El resto queda agrupado para no contaminar la vista principal.</p>
        </div>
      </div>

      {files.length === 0 ? (
        <p>No hay archivos disponibles todavía.</p>
      ) : (
        <div className="artifact-groups">
          {PRIMARY_CATEGORIES.filter((category) => grouped[category].length > 0).map((category) => (
            <div key={category} className="artifact-group">
              <div className="artifact-group-header">
                <h3>{CATEGORY_LABELS[category]}</h3>
                <p>{CATEGORY_DESCRIPTIONS[category]}</p>
              </div>
              <ul className="file-list">
                {grouped[category].map((file) => (
                  <li key={`${file.itemId ?? 'job'}-${file.relativePath}`} className="file-list-item">
                    <div>
                      <div className="file-list-title-row">
                        <a href={getDownloadHref(file)} target={isWordDocument(file) ? undefined : '_blank'} rel="noreferrer" download={isWordDocument(file) ? file.filename : undefined}>
                          {getDisplayName(file)}
                        </a>
                        <span className={`artifact-badge artifact-${file.category}`}>{file.category}</span>
                      </div>
                      <span className="file-list-meta">{new Date(file.createdAt).toLocaleString()}</span>
                    </div>
                    <span className="file-list-size">{formatFileSize(file.size)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {SECONDARY_CATEGORIES.some((category) => grouped[category].length > 0) ? (
            <details className="disclosure-card">
              <summary>Ver archivos forenses y de debug</summary>
              <div className="disclosure-content forensic-artifacts">
                {SECONDARY_CATEGORIES.filter((category) => grouped[category].length > 0).map((category) => (
                  <div key={category} className="artifact-group artifact-group-secondary">
                    <div className="artifact-group-header">
                      <h3>{CATEGORY_LABELS[category]}</h3>
                      <p>{CATEGORY_DESCRIPTIONS[category]}</p>
                    </div>
                    <ul className="file-list">
                      {grouped[category].map((file) => (
                        <li key={`${file.itemId ?? 'job'}-${file.relativePath}`} className="file-list-item">
                          <div>
                            <div className="file-list-title-row">
                              <a href={getDownloadHref(file)} target={isWordDocument(file) ? undefined : '_blank'} rel="noreferrer" download={isWordDocument(file) ? file.filename : undefined}>
                                {getDisplayName(file)}
                              </a>
                              <span className={`artifact-badge artifact-${file.category}`}>{file.category}</span>
                            </div>
                            <span className="file-list-meta">{new Date(file.createdAt).toLocaleString()}</span>
                          </div>
                          <span className="file-list-size">{formatFileSize(file.size)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}
    </section>
  );
}
