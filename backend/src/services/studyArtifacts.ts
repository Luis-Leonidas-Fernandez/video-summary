import { appConfig } from '../config.js';

interface PartArtifact {
  partNumber: number;
  content: string;
}

function secondsToTimestamp(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
  }

  return [minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function extractTitle(content: string): string | null {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const titleHeadingIndex = lines.findIndex((line) => /^##\s+t[ií]tulo probable$/i.test(line));
  if (titleHeadingIndex === -1) {
    return null;
  }

  for (let index = titleHeadingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^-\s+(.+)$/);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function extractBullets(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^-+\s+/, '').trim());
}

function extractTopicHeadings(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^###\s+/.test(line))
    .map((line) => line.replace(/^###\s+/, '').trim())
    .filter((line) => line.length >= 3);
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(value);
  }

  return unique;
}

function extractConceptLabel(bullet: string): string {
  const boldMatch = bullet.match(/^\*\*(.+?)\*\*/);
  if (boldMatch?.[1]) {
    return boldMatch[1].trim();
  }

  const colonIndex = bullet.indexOf(':');
  if (colonIndex > 0) {
    return bullet.slice(0, colonIndex).trim();
  }

  return bullet.split(/[.]/, 1)[0].trim();
}

export function generateOutline(parts: PartArtifact[]): string {
  const lines = parts.map(({ partNumber, content }) => {
    const startSeconds = (partNumber - 1) * appConfig.videoPartDurationSeconds;
    const endSeconds = partNumber * appConfig.videoPartDurationSeconds;
    const title = extractTitle(content) ?? `Parte ${String(partNumber).padStart(3, '0')}`;

    return `${secondsToTimestamp(startSeconds)} - ${secondsToTimestamp(endSeconds)} ${title}`;
  });

  return `${lines.join('\n')}\n`;
}

export function generateKeyConcepts(parts: PartArtifact[]): string {
  const concepts = dedupePreserveOrder(
    parts.flatMap(({ content }) => [
      ...extractTopicHeadings(content),
      ...extractBullets(content)
        .map(extractConceptLabel)
        .filter((label) => label.length >= 3),
    ]),
  ).slice(0, 60);

  return `${concepts.map((concept) => `- ${concept}`).join('\n')}\n`;
}

export function generateGlossary(parts: PartArtifact[]): string {
  const glossaryEntries = dedupePreserveOrder(
    parts.flatMap(({ content }) =>
      extractBullets(content).filter((bullet) => bullet.includes(':') || /\*\*.+?\*\*:/.test(bullet)),
    ),
  ).slice(0, 80);

  return `${glossaryEntries.map((entry) => `- ${entry}`).join('\n')}\n`;
}

export function generateStudyQuestions(parts: PartArtifact[]): string {
  const titles = parts.map(({ content, partNumber }) => extractTitle(content) ?? `Parte ${partNumber}`);
  const keyConcepts = dedupePreserveOrder(
    parts.flatMap(({ content }) => [
      ...extractTopicHeadings(content),
      ...extractBullets(content).map(extractConceptLabel),
    ]),
  ).slice(0, 4);

  const questions = [
    '1. ¿Cuál es la idea principal del video y cómo se sostiene a lo largo de todas las partes?',
    `2. ¿Cómo evoluciona el contenido desde ${titles[0] ?? 'la primera parte'} hasta ${titles.at(-1) ?? 'la última parte'}?`,
    `3. ¿Qué conceptos o términos son más importantes para entender el video completo: ${keyConcepts.join(', ')}?`,
    '4. ¿Qué argumentos, ejemplos o evidencias aparecen para justificar las afirmaciones principales?',
    '5. ¿Qué partes del contenido conviene revisar de nuevo antes de estudiar o citar este material?',
  ];

  return `${questions.join('\n')}\n`;
}
