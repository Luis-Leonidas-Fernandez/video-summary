interface SummaryPreviewProps {
  content: string | null;
  isLoading: boolean;
}

function renderLine(line: string, index: number) {
  const trimmed = line.trim();

  if (!trimmed) {
    return <div key={`spacer-${index}`} className="summary-spacer" />;
  }

  if (/^#+\s+/.test(trimmed)) {
    return (
      <h3 key={`heading-${index}`} className="summary-heading">
        {trimmed.replace(/^#+\s+/, '')}
      </h3>
    );
  }

  if (trimmed.startsWith('- ')) {
    return (
      <li key={`item-${index}`} className="summary-item">
        {trimmed.replace(/^-+\s+/, '')}
      </li>
    );
  }

  return (
    <p key={`paragraph-${index}`} className="summary-paragraph">
      {trimmed}
    </p>
  );
}

export function SummaryPreview({ content, isLoading }: SummaryPreviewProps) {
  const lines = content?.split(/\r?\n/) ?? [];

  const blocks: JSX.Element[] = [];
  let bulletBuffer: string[] = [];
  let bulletStartIndex = 0;

  const flushBullets = () => {
    if (bulletBuffer.length === 0) {
      return;
    }

    blocks.push(
      <ul key={`list-${bulletStartIndex}`} className="summary-list">
        {bulletBuffer.map((item, offset) => renderLine(item, bulletStartIndex + offset))}
      </ul>,
    );
    bulletBuffer = [];
  };

  lines.forEach((line, index) => {
    if (line.trim().startsWith('- ')) {
      if (bulletBuffer.length === 0) {
        bulletStartIndex = index;
      }
      bulletBuffer.push(line);
      return;
    }

    flushBullets();
    blocks.push(renderLine(line, index));
  });

  flushBullets();

  return (
    <section className="panel">
      <h2>Material de estudio generado</h2>

      {isLoading && !content ? <p>Cargando material de estudio...</p> : null}

      {!isLoading && !content ? (
        <p>Cuando el job genere <code>full_study_notes_es.txt</code>, lo vas a ver estructurado acá.</p>
      ) : null}

      {content ? <div className="summary-preview">{blocks}</div> : null}
    </section>
  );
}
