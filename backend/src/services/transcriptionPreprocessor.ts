const SPANISH_STOPWORDS = new Set([
  'que', 'con', 'una', 'uno', 'los', 'las', 'del', 'por', 'para', 'como',
  'pero', 'este', 'esta', 'estos', 'estas', 'también', 'más', 'muy',
  'todo', 'toda', 'todos', 'todas', 'cuando', 'donde', 'desde', 'hasta',
  'entre', 'sobre', 'hay', 'son', 'ser', 'está', 'han', 'van', 'vamos',
  'puede', 'tienen', 'tienen', 'decir', 'hacer', 'ver', 'dar', 'tener',
  'solo', 'bien', 'ahí', 'aquí', 'allí', 'nos', 'les', 'sus', 'nuestro',
  'mismo', 'manera', 'forma', 'vez', 'parte', 'lugar', 'caso', 'punto',
]);

const TRANSITION_PATTERNS = [
  // Spanish
  /^bueno[,\s]/i,
  /^ahora[,\s]/i,
  /^fíjense/i,
  /^empecemos/i,
  /^vamos a/i,
  /^en este sentido/i,
  /^por lo tanto/i,
  /^de este modo/i,
  /^insisto/i,
  /^pero empecemos/i,
  /^en este principio/i,
  /^en términos de/i,
  /^si reconocemos/i,
  /^en otros momentos/i,
  /^¿qué es lo que/i,
  /^entonces[,\s]/i,
  // English
  /^(so\s+)?let'?s\s+(start|begin|look|take|talk|walk|move|build|create|define|now)/i,
  /^(first|second|third|next|finally|lastly)[,.:]/i,
  /^step\s+\d+[,.:]/i,
  /^moving on/i,
  /^and\s+(now|finally)[,\s]/i,
  /^the\s+(first|second|third|next|final|last)\s+(step|phase|thing|part)/i,
  /^(now,?\s+)?let me\s+(show|explain|walk|start|talk|look|introduce)/i,
  /^(alright|okay)[,\s]+so\s/i,
  /^to\s+(recap|summarize|sum up)/i,
];

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+(?=[A-ZÁÉÍÓÚÜÑ¿])/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);
}

function buildSections(sentences: string[]): string[][] {
  const sections: string[][] = [[]];

  for (const sentence of sentences) {
    const isTransition = TRANSITION_PATTERNS.some((re) => re.test(sentence));
    const current = sections[sections.length - 1];

    if (isTransition && current.length >= 2) {
      sections.push([sentence]);
    } else {
      current.push(sentence);
    }
  }

  // Merge sections with a single sentence into the previous one
  const merged: string[][] = [];
  for (const section of sections) {
    if (section.length === 1 && merged.length > 0) {
      merged[merged.length - 1].push(...section);
    } else if (section.length > 0) {
      merged.push(section);
    }
  }

  return merged;
}

function extractKeyTerms(text: string): string[] {
  const lower = text.toLowerCase();

  const knownTerms = [
    'axioma', 'axiomas',
    'feedback', 'retroalimentación',
    'emisor', 'receptor',
    'código', 'códigos',
    'canal',
    'ruido', 'ruidos', 'filtro', 'filtros', 'barrera', 'barreras',
    'monólogo', 'interrogación',
    'comunicación intrapersonal', 'comunicación no verbal',
    'comunicación transubjetiva',
    'circuito comunicacional',
    'sine qua non',
    'acción comunicacional', 'acciones comunicacionales',
  ];

  const foundKnown = knownTerms.filter((t) => lower.includes(t));

  // Frequency-based: words ≥6 chars, appearing ≥3 times, not stopwords
  const words = lower.match(/\b[a-záéíóúüñ]{6,}\b/g) ?? [];
  const freq = new Map<string, number>();
  for (const word of words) {
    if (!SPANISH_STOPWORDS.has(word)) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  const frequent = [...freq.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word]) => word)
    .filter((w) => !foundKnown.some((k) => k.includes(w)));

  return [...new Set([...foundKnown, ...frequent])];
}

function formatStructured(sections: string[][], terms: string[]): string {
  const lines: string[] = [];

  lines.push('=== TRANSCRIPCIÓN ESTRUCTURADA ===');
  lines.push('');

  if (terms.length > 0) {
    lines.push(`TÉRMINOS TÉCNICOS (PRESERVAR EXACTAMENTE, NO PARAFRASEAR): ${terms.join(', ')}`);
    lines.push('');
  }

  for (let i = 0; i < sections.length; i++) {
    lines.push(`--- SECCIÓN ${i + 1} / ${sections.length} ---`);
    lines.push(sections[i].join(' '));
    lines.push('');
  }

  return lines.join('\n');
}

export function preprocessTranscription(rawText: string): string {
  const sentences = splitSentences(rawText);
  const sections = buildSections(sentences);
  const terms = extractKeyTerms(rawText);
  return formatStructured(sections, terms);
}
