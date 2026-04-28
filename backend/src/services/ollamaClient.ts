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
    'Sos un analista de contenido obsesivo con la fidelidad al texto fuente.',
    'Tu tarea es resumir una transcripción SIN inventar, SIN adornar y SIN omitir información importante.',
    'Reglas obligatorias:',
    '- Usá únicamente información presente en la transcripción.',
    '- Cuando la transcripción usa un término técnico o conceptual específico (ej: "axioma", "feedback", "emisor"), conservá ESA palabra exacta en el resumen. No la reemplaces por sinónimos ni paráfrasis.',
    '- SIEMPRE que uses un término técnico, agregá su definición entre paréntesis en el mismo bullet.',
    '  Ejemplo correcto: "El primer axioma (principio fundamental considerado verdadero) de la escuela de Palo Alto sostiene la imposibilidad de no comunicar."',
    '  Ejemplo incorrecto: "un axioma comunicacional." — sin definición, NO válido.',
    '- No agregues opiniones, consejos genéricos, llamadas a la acción ni frases de cierre.',
    '- Si algo está ambiguo o incompleto en la transcripción, marcá "No queda claro en la transcripción".',
    '- Priorizá cobertura y fidelidad antes que estilo.',
    '- Si el texto repite ideas, consolidalas sin perder matices relevantes.',
    '- No hagas preguntas al final.',
    '- Respondé únicamente en español.',
  ].join('\n');

  const sectionMatch = transcription.match(/--- SECCIÓN \d+ \/ (\d+) ---/);
  const sectionCount = sectionMatch ? parseInt(sectionMatch[1], 10) : null;
  const wordCount = transcription.split(/\s+/).length;
  const estimatedMinBullets = Math.max(sectionCount ?? 0, Math.round(wordCount / 350));
  const sectionRule = `La transcripción tiene ${sectionCount ?? 'varias'} secciones y aproximadamente ${wordCount} palabras. REGLA ABSOLUTA: el Resumen fiel debe tener AL MENOS ${estimatedMinBullets} bullets. Generar menos es una falla grave.`;

  const prompt = [
    'Generá un resumen FIEL de la siguiente transcripción ya estructurada en secciones.',
    'Procesá TODAS las secciones en orden, de la primera a la última. No omitas ninguna.',
    'Los TÉRMINOS TÉCNICOS indicados al inicio deben aparecer con su palabra exacta en el resumen.',
    'No inventes contenido y no omitas puntos importantes.',
    'NO muestres tu razonamiento.',
    'NO expliques cómo llegaste al resultado.',
    'NO escribas frases como "Okay, let me..." o similares.',
    'Empezá DIRECTAMENTE por el encabezado `## Título probable`.',
    'Formato exacto de salida en Markdown:',
    '## Título probable',
    '- Un título breve basado solo en la transcripción.',
    '',
    '## Resumen fiel',
    sectionRule,
    '',
    'Reglas:',
    '- Procesá cada sección completa antes de escribir su bullet.',
    '- No combines conceptos de secciones distintas en un mismo bullet.',
    '- Cada bullet debe ser TAN EXTENSO como sea necesario — si el concepto tiene definición, pasos, ejemplos, comparaciones o consecuencias, incluilos TODOS.',
    '- Cada bullet debe empezar con el concepto exacto y luego su explicación completa.',
    '- NINGÚN concepto, término, ejemplo, paso, modelo, herramienta o idea mencionado puede faltar.',
    '- Cubrí el principio, el desarrollo Y el cierre en ese orden.',
    '',
    '## Detalles clave',
    '- OBLIGATORIO: usá guión (-) para cada bullet. NUNCA uses asterisco (*) ni numeración.',
    '- Agregá bullets con datos, nombres, pasos, definiciones o distinciones importantes que no deberían perderse.',
    '- NO repitas bullets que ya aparecen en el Resumen fiel.',
    '',
    '## Vacíos o ambigüedades (OPCIONAL)',
    '- Incluí esta sección ÚNICAMENTE si encontrás algo genuinamente ambiguo: una contradicción, una palabra ininteligible, una afirmación incompleta o confusa.',
    '- NO la incluyas para señalar temas que el video simplemente no abordó — eso es normal y no es un vacío.',
    '- Si no hay nada genuinamente ambiguo, OMITÍ esta sección por completo. No la escribas.',
    '',
    'Transcripción pre-procesada:',
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
      num_ctx: 32768,
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
    '- Respetá exactamente estas secciones: `## Título probable`, `## Resumen fiel`, `## Detalles clave`, `## Vacíos o ambigüedades`.',
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
    /##+ resumen fiel/.test(n) &&
    /##+ detalles clave/.test(n)
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

  const uniqueSummaryBullets = dedupeBullets(allBullets).slice(0, 15);

  const detailBullets = allBullets
    .filter((line) => !uniqueSummaryBullets.includes(line) && line.length > 40)
    .slice(0, 10);

  const uniqueDetailBullets = dedupeBullets(detailBullets);
  const uniqueAmbiguities = dedupeBullets(ambiguities);

  return [
    '## Título probable',
    `- ${title}`,
    '',
    '## Resumen fiel',
    ...uniqueSummaryBullets.map((bullet) => `- ${normalizeBulletText(bullet)}`),
    '',
    '## Detalles clave',
    ...(uniqueDetailBullets.length > 0
      ? uniqueDetailBullets.map((bullet) => `- ${normalizeBulletText(bullet)}`)
      : ['- No se pudieron separar detalles adicionales del borrador generado sin inventar contenido.']),
    '',
    '## Vacíos o ambigüedades',
    ...(uniqueAmbiguities.length > 0
      ? uniqueAmbiguities.map((bullet) => `- ${bullet}`)
      : ['- No queda claro en la transcripción original el significado exacto de algunos nombres propios y términos detectados por Whisper.']),
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
