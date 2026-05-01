import { appConfig } from '../config.js';
import { preprocessTranscription } from './transcriptionPreprocessor.js';

interface OllamaChatResponse {
  message?: {
    content?: string;
    thinking?: string;
  };
  error?: string;
}

export async function generateSpanishSummary(rawTranscription: string): Promise<string> {
  const transcription = preprocessTranscription(rawTranscription);
  const system = [
    'Sos un documentador de contenido obsesivo con la completitud y la fidelidad al texto fuente.',
    'Tu tarea NO es resumir — es DOCUMENTAR cada concepto, término, idea y evento presente en la transcripción.',
    'Reglas obligatorias:',
    '- Usá únicamente información presente en la transcripción.',
    '- Cada término, concepto o idea recibe su propio bullet con su explicación completa.',
    '- Cuando aparece un término específico (japonés, técnico, cultural), incluí el término exacto seguido de su explicación.',
    '  Ejemplo: "Karoshi (muerte por exceso de trabajo): diagnóstico médico oficial en Japón..."',
    '- No comprimas ni agrupes ideas distintas en un solo bullet.',
    '- No agregues opiniones, consejos genéricos ni frases de cierre.',
    '- No hagas preguntas al final.',
    '- Respondé únicamente en español.',
  ].join('\n');

  const wordCount = transcription.split(/\s+/).length;
  const coverageRule = [
    `La transcripción tiene aproximadamente ${wordCount} palabras.`,
    'ESTE NO ES UN RESUMEN — es un desglose completo.',
    'Cada bullet documenta UN concepto, término, idea, evento o personaje.',
    'El objetivo es que alguien que no vio el video entienda CADA parte del contenido leyendo los bullets.',
    'PROHIBIDO comprimir. PROHIBIDO agrupar. PROHIBIDO omitir.',
    'Si el contenido tiene 30 ideas distintas, el desglose tiene 30 bullets.',
  ].join('\n');

  const prompt = [
    'Documentá el contenido completo de la siguiente transcripción, de principio a fin.',
    coverageRule,
    '',
    'Recorré el contenido en orden cronológico sin saltear nada.',
    'Cuando aparezca un término en otro idioma, incluí el término original y su explicación.',
    'No inventes contenido.',
    'NO muestres tu razonamiento.',
    'NO escribas frases como "Okay, let me..." o similares.',
    'Empezá DIRECTAMENTE por el encabezado `## Título probable`.',
    'Formato exacto de salida en Markdown:',
    '## Título probable',
    '- Un título breve basado solo en la transcripción.',
    '',
    '## Contenido',
    'Reglas:',
    '- Un bullet por concepto, término, idea, evento o personaje.',
    '- Cada bullet empieza con el nombre o concepto exacto, seguido de dos puntos y su explicación completa.',
    '- Incluí definición, contexto, ejemplos, cifras y consecuencias si el contenido los menciona.',
    '- Recorré el contenido de inicio a fin — el orden de los bullets debe seguir el orden del video.',
    '- NADA puede faltar: personajes, términos, eventos, datos, reflexiones finales.',
    '',
    '## Vacíos o ambigüedades (OPCIONAL)',
    '- Incluí esta sección ÚNICAMENTE si hay algo genuinamente ambiguo: una contradicción, una palabra ininteligible o una afirmación incompleta.',
    '- NO la incluyas para temas que el video simplemente no abordó.',
    '- Si no hay nada genuinamente ambiguo, OMITÍ esta sección por completo.',
    '',
    'Transcripción:',
    '"""',
    transcription,
    '"""',
  ].join('\n');

  const raw = await completeResponse({ system, prompt });
  const sanitized = sanitizeSummaryOutput(raw);

  if (isStructuredSummary(sanitized)) {
    return sanitized;
  }

  const repaired = await repairSummaryOutput(raw, transcription);
  const repairedSanitized = sanitizeSummaryOutput(repaired);

  if (isStructuredSummary(repairedSanitized)) {
    return repairedSanitized;
  }

  const recovered = recoverStructuredSummary(raw, transcription);
  if (recovered) {
    return recovered;
  }

  throw new Error('Ollama devolvió un resumen sin el formato esperado y no se pudo recuperar.');
}

const CONTINUATION_PROMPT = [
  'Continuá exactamente desde donde te cortaste.',
  'No repitas nada de lo que ya escribiste.',
  'No agregues prefacios ni explicaciones.',
  'Empezá directamente con la palabra donde te detuviste.',
].join('\n');

function isOutputComplete(text: string): boolean {
  const lastLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? '';
  return /[.!?)"""»]$/.test(lastLine);
}

async function completeResponse({
  system,
  prompt,
  maxContinuations = 3,
}: {
  system: string;
  prompt: string;
  maxContinuations?: number;
}): Promise<string> {
  let fullText = await runOllamaChat({ system, prompt });

  for (let i = 0; i < maxContinuations; i++) {
    if (isOutputComplete(fullText)) break;
    const continuation = await runOllamaChat({ system, prompt, priorAssistantContent: fullText });
    const trimmedContinuation = continuation.trimStart();
    const separator = trimmedContinuation.startsWith('#') ? '\n\n' : ' ';
    fullText = `${fullText.trimEnd()}${separator}${trimmedContinuation}`;
  }

  return fullText;
}

async function runOllamaChat({
  system,
  prompt,
  priorAssistantContent,
}: {
  system: string;
  prompt: string;
  priorAssistantContent?: string;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), appConfig.ollamaTimeoutMs);

  const messages: Array<{ role: string; content: string }> = priorAssistantContent
    ? [
        { role: 'system', content: system },
        { role: 'user', content: 'Continuá el resumen que empezaste. La transcripción ya fue proporcionada.' },
        { role: 'assistant', content: priorAssistantContent },
        { role: 'user', content: CONTINUATION_PROMPT },
      ]
    : [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ];

  const requestBody: Record<string, unknown> = {
    model: appConfig.ollamaModel,
    stream: false,
    messages,
    options: {
      temperature: 0.1,
      top_p: 0.9,
      repeat_penalty: 1.05,
      num_ctx: appConfig.ollamaNumCtx,
      num_predict: appConfig.ollamaNumPredict,
    },
  };

  if (supportsThinkingToggle(appConfig.ollamaModel)) {
    requestBody.think = false;
  }

  try {
    const response = await fetch(`${appConfig.ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama respondió con HTTP ${response.status}.`);
    }

    const data = (await response.json()) as OllamaChatResponse;

    if (data.error) {
      throw new Error(data.error);
    }

    const text = data.message?.content?.trim() ?? '';
    if (!text) {
      throw new Error('Ollama no devolvió contenido de resumen.');
    }

    return text;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Ollama agotó el tiempo de espera al generar el resumen.');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function repairSummaryOutput(rawSummary: string, transcription: string): Promise<string> {
  const system = [
    'Sos un editor estricto.',
    'Recibís una salida defectuosa de otro modelo.',
    'Tu trabajo es ENTREGAR SOLO la versión final limpia, sin razonamiento visible y en el formato pedido.',
    'No expliques nada. No agregues prefacios. No menciones que estás corrigiendo una respuesta.',
    'Respondé únicamente en español.',
  ].join('\n');

  const prompt = [
    'Reescribí esta salida defectuosa para convertirla en una respuesta final válida.',
    'Condiciones obligatorias:',
    '- Eliminá cualquier razonamiento interno, dudas, prefacios o frases como "Okay, I need..."',
    '- Usá solo información presente en la transcripción fuente.',
    '- Empezá DIRECTAMENTE con `## Título probable`.',
    '- Respetá exactamente estas secciones: `## Título probable`, `## Contenido`, `## Vacíos o ambigüedades` (opcional).',
    '',
    'Salida defectuosa:',
    '"""',
    rawSummary,
    '"""',
    '',
    'Transcripción fuente:',
    '"""',
    transcription,
    '"""',
  ].join('\n');

  return completeResponse({ system, prompt });
}

function sanitizeSummaryOutput(raw: string): string {
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();

  if (!text) {
    return '';
  }

  // Strip any preamble before the first ## heading
  const firstHeadingMatch = text.search(/^##+ /m);
  if (firstHeadingMatch >= 0) {
    text = text.slice(firstHeadingMatch).trim();
  }

  // Normalize * bullets to -
  text = text.replace(/^\*+\s+/gm, '- ');

  // Convert paragraph sections to bullet lists
  text = convertParagraphsToBullets(text);

  return text;
}

function convertParagraphsToBullets(text: string): string {
  const parts = text.split(/(?=^##+ )/m);

  return parts
    .map((part) => {
      const headingMatch = part.match(/^(##+ [^\n]+)\n([\s\S]*)/);
      if (!headingMatch) return part;

      const [, heading, body] = headingMatch;
      const trimmed = body.trim();

      if (!trimmed) return `${heading}\n`;

      const hasBullets = /^[-•]\s/m.test(trimmed);
      if (hasBullets) return `${heading}\n${trimmed}\n\n`;

      const sentences = trimmed
        .split(/(?<=[.?!])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 10);

      if (sentences.length <= 1) return `${heading}\n${trimmed}\n\n`;

      const bullets = sentences.map((s) => `- ${s}`).join('\n');
      return `${heading}\n${bullets}\n\n`;
    })
    .join('');
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function isStructuredSummary(text: string): boolean {
  const n = normalizeText(text);
  return (
    /##+ titulo probable/.test(n) &&
    /##+ contenido/.test(n)
  );
}

function supportsThinkingToggle(model: string): boolean {
  return /qwen|deepseek|gpt-oss/i.test(model);
}

function recoverStructuredSummary(raw: string, transcription: string): string | null {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const title = extractRecoveredTitle(lines) ?? inferFallbackTitle(transcription);

  const allBullets = lines
    .map((line) => {
      const numbered = line.match(/^\d+\.\s+(.+)$/);
      if (numbered?.[1]) return numbered[1].trim();
      const dashed = line.match(/^[-–•]\s+(.+)$/);
      if (dashed?.[1]) return dashed[1].trim();
      return null;
    })
    .filter((line): line is string => Boolean(line));

  if (allBullets.length === 0) {
    return null;
  }

  const ambiguities = lines
    .filter((line) => /maybe|probably|typo|not clear|unclear|ambiguous/i.test(line))
    .map(normalizeBulletText);

  const uniqueContentBullets = dedupeBullets(allBullets);
  const uniqueAmbiguities = dedupeBullets(ambiguities);

  return [
    '## Título probable',
    `- ${title}`,
    '',
    '## Contenido',
    ...uniqueContentBullets.map((bullet) => `- ${normalizeBulletText(bullet)}`),
    ...(uniqueAmbiguities.length > 0
      ? ['', '## Vacíos o ambigüedades', ...uniqueAmbiguities.map((bullet) => `- ${bullet}`)]
      : []),
  ].join('\n');
}

function extractRecoveredTitle(lines: string[]): string | null {
  for (const line of lines) {
    const quotedMatch = line.match(/title should be(?: something like)?\s+"([^"]+)"/i);
    if (quotedMatch?.[1]) {
      return quotedMatch[1].trim();
    }

    const colonMatch = line.match(/^first, the title\.?.*?:\s*(.+)$/i);
    if (colonMatch?.[1]) {
      return cleanupRecoveredTitle(colonMatch[1]);
    }
  }

  return null;
}

function inferFallbackTitle(transcription: string): string {
  const isPreprocessorArtifact = (line: string): boolean =>
    /^[=\-]{3,}/.test(line) ||
    /^TÉRMINOS\s+TÉCNICOS/i.test(line) ||
    /^TRANSCRIPCIÓN/i.test(line) ||
    /^SECCIÓN\s+\d+/i.test(line);

  const sentences = transcription
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 20 && !isPreprocessorArtifact(l));

  const completeSentence = sentences.find((s) => /[.!?]$/.test(s));
  const candidate = completeSentence ?? sentences[0];

  if (candidate) {
    const firstSentence = candidate.match(/^[^.!?]+[.!?]/)?.[0] ?? candidate;
    return firstSentence.trim().slice(0, 120);
  }

  return 'Resumen de la transcripción';
}

function cleanupRecoveredTitle(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim();
}

function normalizeBulletText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[-–•]\s*/, '')
    .trim();
}

function dedupeBullets(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const normalized = item.toLowerCase().trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(item.trim());
  }

  return result;
}
