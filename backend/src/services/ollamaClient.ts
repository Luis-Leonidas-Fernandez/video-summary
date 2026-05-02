import { appConfig } from '../config.js';
import { preprocessTranscription } from './transcriptionPreprocessor.js';

interface OllamaChatResponse {
  message?: {
    content?: string;
    thinking?: string;
  };
  error?: string;
}

interface RepairExtractionInput {
  rawExtraction: string;
  transcription: string;
  strongFlags: string[];
}

export async function generateSpanishSummary(rawTranscription: string): Promise<string> {
  const transcription = preprocessTranscription(rawTranscription);
  const system = [
    'Sos un redactor de apuntes de estudio obsesivo con la completitud, la claridad y la fidelidad al texto fuente.',
    'Tu tarea NO es resumir en pocas líneas: es EXTRAER y EXPLICAR casi todo el contenido del tramo sin inventar nada.',
    'Reglas obligatorias:',
    '- Usá únicamente información presente en la transcripción.',
    '- NO agregar conceptos que no aparezcan explícitamente o inequívocamente en la transcripción.',
    '- NO expandir listas más allá de lo mencionado en el texto.',
    '- NO completar con conocimiento propio.',
    '- Si detectás que estás enumerando elementos de forma repetitiva o extensa sin valor adicional, detené la enumeración.',
    '- Priorizá explicación del contenido dicho por el orador, no taxonomías, catálogos ni series artificiales.',
    '- Agrupá el contenido por temas reales del tramo.',
    '- Los bullets solo se usan como apoyo para puntos clave, ejemplos o relaciones.',
    '- No agregues opiniones, consejos genéricos ni frases de cierre.',
    '- No hagas preguntas al final.',
    '- Respondé únicamente en español.',
  ].join('\n');

  const wordCount = transcription.split(/\s+/).length;
  const coverageRule = [
    `La transcripción tiene aproximadamente ${wordCount} palabras.`,
    'ESTO NO ES UN RESUMEN CORTO: es una extracción exhaustiva y explicativa.',
    'El objetivo es que alguien que no vio el video entienda el tramo leyendo apuntes claros y fieles.',
    'Cubrir casi todo NO significa inflar con listas artificiales.',
    'Podés agrupar ideas si pertenecen al mismo tema real del tramo.',
    'PROHIBIDO inventar, extrapolar o completar con conocimiento externo.',
  ].join('\n');

  const prompt = [
    'Extraé y explicá el contenido completo de la siguiente transcripción, de principio a fin.',
    coverageRule,
    '',
    'Recorré el contenido en orden cronológico sin saltear nada.',
    'Cuando aparezca un término técnico, doctrinal o en otro idioma, explicalo solo si realmente aparece en la transcripción.',
    'No inventes contenido.',
    'NO muestres tu razonamiento.',
    'NO escribas frases como "Okay, let me..." o similares.',
    'Empezá DIRECTAMENTE por el encabezado `## Título probable`.',
    'Formato exacto de salida en Markdown:',
    '## Título probable',
    '- Un título breve basado solo en la transcripción.',
    '',
    '## Contenido explicado',
    'Reglas:',
    '- Organizá la salida por temas usando subtítulos `### Tema ...` o `### <nombre del tema>`.',
    '- Debajo de cada tema, escribí una explicación breve en lenguaje natural.',
    '- Usá bullets solo para puntos clave, ejemplos, relaciones o consecuencias mencionadas.',
    '- Solo usá el formato `Término: explicación` cuando el video realmente trate ese término como unidad relevante.',
    '- Recorré el contenido de inicio a fin: el orden de los temas debe seguir el orden del video.',
    '- NADA importante puede faltar: argumentos, ejemplos, nombres, relaciones, citas doctrinales, conclusiones y matices del tramo.',
    '- NO conviertas la salida en un glosario ni en una lista interminable de etiquetas.',
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

  throw new Error('Ollama devolvió una extracción sin el formato esperado y no se pudo recuperar.');
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
        { role: 'user', content: 'Continuá la extracción de estudio que empezaste. La transcripción ya fue proporcionada.' },
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
      throw new Error('Ollama no devolvió contenido de extracción.');
    }

    return text;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Ollama agotó el tiempo de espera al generar la extracción.');
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
    '- Respetá exactamente estas secciones: `## Título probable`, `## Contenido explicado`, `## Vacíos o ambigüedades` (opcional).',
    '- Dentro de `## Contenido explicado`, organizá por temas usando subtítulos `### ...`.',
    '- No conviertas la salida en una lista infinita de términos.',
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

export async function repairSpanishSummary({
  rawExtraction,
  transcription,
  strongFlags,
}: RepairExtractionInput): Promise<string> {
  const system = [
    'Sos un editor estricto de apuntes de estudio.',
    'Recibís una extracción defectuosa y tu trabajo es devolver SOLO una versión final corregida y fiel.',
    'Respondé únicamente en español.',
    'No expliques nada. No menciones que corregiste la salida.',
  ].join('\n');

  const prompt = [
    'Corregí esta extracción defectuosa para que sea válida.',
    'Problemas detectados:',
    ...strongFlags.map((flag) => `- ${flag}`),
    '',
    'Reglas obligatorias:',
    '- Usá solo información presente en la transcripción fuente.',
    '- Empezá DIRECTAMENTE con `## Título probable`.',
    '- Respetá exactamente estas secciones: `## Título probable`, `## Contenido explicado`, `## Vacíos o ambigüedades` (opcional).',
    '- Organizá `## Contenido explicado` por temas usando subtítulos `### ...`.',
    '- No expandas listas. No inventes taxonomías. No agregues entidades nuevas.',
    '- Si una lista empieza a repetirse o inflarse, cortala y explicá el punto en lenguaje natural.',
    '',
    'Extracción defectuosa:',
    '"""',
    rawExtraction,
    '"""',
    '',
    'Transcripción fuente:',
    '"""',
    transcription,
    '"""',
  ].join('\n');

  return completeResponse({ system, prompt, maxContinuations: 1 });
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

  return text;
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
    /##+ contenido explicado/.test(n)
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
    '## Contenido explicado',
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
