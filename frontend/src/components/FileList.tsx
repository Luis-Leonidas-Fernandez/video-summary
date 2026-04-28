import type { JobFile } from '../api';

interface FileListProps {
  files: JobFile[];
}

export function FileList({ files }: FileListProps) {
  return (
    <section className="panel">
      <h2>Archivos generados</h2>

      {files.length === 0 ? (
        <p>No hay archivos disponibles todavía.</p>
      ) : (
        <ul className="file-list">
          {files.map((file) => (
            <li key={file.name}>
              <a href={file.downloadUrl} target="_blank" rel="noreferrer">
                {file.name}
              </a>
              <span>{Math.max(1, Math.round(file.size / 1024))} KB</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
