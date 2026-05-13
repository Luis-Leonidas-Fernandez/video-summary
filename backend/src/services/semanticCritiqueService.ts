import { appConfig } from '../config.js'
import { completeOllamaResponse } from './ollamaClient.js'
import { renderEvidenceWindowMarkdown } from './evidenceWindowService.js'
import type { EvidenceDerivedPromptHints } from './evidenceDerivedPromptHintsService.js'
import type { JsonSchemaObject } from './outputSchemas.js'
import type { EvidenceWindow, GroundedWindowExtraction } from './groundingTypes.js'
import type { SemanticRichnessAssessment } from './semanticRichnessClassifier.js'

export interface SemanticCritique {
  missingReasoning: string[]
  weakBlocks: Array<{
    heading: string
    issue: string
    fix: string
  }>
  rewritePriorities: string[]
}

export interface SemanticCritiqueInput {
  window: EvidenceWindow
  originalExtraction: GroundedWindowExtraction
  assessment: SemanticRichnessAssessment
  evidenceHints?: EvidenceDerivedPromptHints
}

function buildSemanticCritiqueSchema(): JsonSchemaObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['missingReasoning', 'weakBlocks', 'rewritePriorities'],
    properties: {
      missingReasoning: {
        type: 'array',
        items: { type: 'string' },
      },
      weakBlocks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['heading', 'issue', 'fix'],
          properties: {
            heading: { type: 'string' },
            issue: { type: 'string' },
            fix: { type: 'string' },
          },
        },
      },
      rewritePriorities: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  }
}

function parseSemanticCritique(rawOutput: string): { ok: true; value: SemanticCritique } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(rawOutput) as Partial<SemanticCritique>
    return {
      ok: true,
      value: {
        missingReasoning: Array.isArray(parsed.missingReasoning)
          ? parsed.missingReasoning.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : [],
        weakBlocks: Array.isArray(parsed.weakBlocks)
          ? parsed.weakBlocks
            .filter((item) =>
              item
              && typeof item.heading === 'string'
              && typeof item.issue === 'string'
              && typeof item.fix === 'string',
            )
            .map((item) => ({
              heading: item.heading,
              issue: item.issue,
              fix: item.fix,
            }))
          : [],
        rewritePriorities: Array.isArray(parsed.rewritePriorities)
          ? parsed.rewritePriorities.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : [],
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo parsear la crítica semántica.',
    }
  }
}

export async function critiqueThinReasoningDraft(
  input: SemanticCritiqueInput,
): Promise<{ ok: true; value: SemanticCritique; rawOutput: string } | { ok: false; error: string; rawOutput?: string }> {
  const system = [
    'Sos un crítico editorial grounded.',
    'No reescribas la respuesta final.',
    'Tu tarea es detectar dónde el draft actual quedó superficial y qué le falta para ganar densidad argumental sin inventar información.',
    'Respondé únicamente con JSON válido.',
    'Solo podés identificar datos concretos que EXISTEN en la evidencia y NO fueron extraídos: números, tiempos, precios, secuencias de razonamiento paso a paso, contrastes explícitos entre elementos nombrados.',
    'PROHIBIDO pedir análisis, explicación conceptual, preguntas retóricas o inferencia que requiera información nueva.',
    'Un fix válido tiene esta forma: "Incluir [dato/secuencia/contraste concreto] de [C_]." Nada más.',
  ].join('\n')

  const prompt = [
    '<problem>',
    'La extracción actual quedó con thin_reasoning y necesita una crítica explícita antes del rewrite.',
    '</problem>',
    '<rules>',
    'Marcá solo faltantes sostenidos por la evidencia.',
    'Podés pedir que se explicite una causalidad, un contraste o una objeción implícita si está TEXTUALMENTE respaldada en la evidencia disponible.',
    'No pidas contexto histórico, ejemplos u objeciones que no aparezcan en la evidencia.',
    'No critiques el formato JSON: criticá la densidad argumental.',
    'No uses ejemplos de dominio fijo.',
    '',
    'FORMATO OBLIGATORIO del campo `heading` de cada weakBlock:',
    '  - Debe ser EXACTAMENTE el texto del heading del bloque de current_extraction. Copialo textualmente.',
    '  - PROHIBIDO parafrasear, resumir o traducir el heading. Copiá el texto literal.',
    '',
    'FORMATO OBLIGATORIO del campo `fix`:',
    '  - Debe referenciar un dato, número, secuencia o contraste ESPECÍFICO de la evidencia.',
    '  - Forma válida: "Incluir [X concreto] de [C_]."',
    '  - PROHIBIDO: preguntas retóricas ("¿cómo impacta...?", "¿para qué tipos de...?", "¿cómo se relaciona...?").',
    '  - PROHIBIDO: pedir que se explique el significado conceptual de algo.',
    '  - PROHIBIDO: pedir análisis de casos de uso, implicaciones o beneficios que no estén en la evidencia.',
    '  - Si no podés formular el fix con un dato concreto de la evidencia, no incluyas ese weakBlock.',
    '</rules>',
    '<current_extraction>',
    JSON.stringify(input.originalExtraction, null, 2),
    '</current_extraction>',
    '<assessment>',
    JSON.stringify({
      failureKind: input.assessment.failureKind,
      missingSignals: input.assessment.missingSignals,
      guidance: input.assessment.guidance,
      signalCounts: input.assessment.signalCounts,
    }, null, 2),
    '</assessment>',
    '<examples>',
    'Ejemplo de fix INVÁLIDO (preguntas retóricas, análisis inferido — PROHIBIDO):',
    JSON.stringify({
      weakBlocks: [
        {
          heading: '[heading sobre rendimiento]',
          issue: 'No explora las implicaciones de las diferencias de velocidad.',
          fix: '¿Cómo impacta la velocidad en la experiencia del usuario? ¿Existen casos donde la velocidad es crítica?',
        },
      ],
    }, null, 2),
    '',
    'Ejemplo de fix VÁLIDO (referencia a dato concreto de la evidencia):',
    JSON.stringify({
      missingReasoning: [
        'El item sobre [afirmación central] omite el dato numérico de [C_] que cuantifica el contraste descrito.',
        'El item sobre [secuencia de razonamiento] no desarrolla los pasos intermedios que sí aparecen en [C_].',
      ],
      weakBlocks: [
        {
          heading: '[COPIAR AQUÍ EL TEXTO EXACTO DEL HEADING EN current_extraction]',
          issue: 'Afirma que los dispositivos difieren en velocidad pero no incluye la métrica concreta de [C_].',
          fix: 'Incluir el dato de velocidad relativa entre dispositivos mencionado en [C_].',
        },
        {
          heading: '[COPIAR AQUÍ EL TEXTO EXACTO DEL HEADING EN current_extraction]',
          issue: 'Menciona que el modelo reconsideró su respuesta pero no reproduce la cadena de pasos que aparece en [C_].',
          fix: 'Incluir la secuencia de pasos intermedios de [C_] que muestra cómo el modelo detectó la inconsistencia y se corrigió.',
        },
      ],
      rewritePriorities: [
        'Incorporar el dato numérico de [C_] en el item de rendimiento.',
        'Desarrollar la secuencia de razonamiento de [C_] en el item correspondiente.',
      ],
    }, null, 2),
    '</examples>',
    '<evidence_derived_prompt_hints>',
    JSON.stringify(input.evidenceHints ?? {
      domainVocabulary: [],
      allowedSystemTerms: [],
      candidateClaims: [],
      candidateContrasts: [],
      candidateObjections: [],
      candidateExamples: [],
      candidateConsequences: [],
    }, null, 2),
    'Los hints son sugerencias derivadas automáticamente. Si un hint no está respaldado por la evidencia, ignoralo.',
    '</evidence_derived_prompt_hints>',
    '<evidence>',
    renderEvidenceWindowMarkdown(input.window),
    '</evidence>',
  ].join('\n')

  const rawOutput = await completeOllamaResponse({
    system,
    prompt,
    maxContinuations: appConfig.maxChainSemanticEnrichmentAttempts,
    responseFormat: buildSemanticCritiqueSchema(),
    profile: {
      numCtx: appConfig.fullNotesOllamaNumCtx,
      numPredict: appConfig.fullNotesOllamaNumPredict,
      keepAlive: appConfig.ollamaKeepAlive,
    },
  })

  const parsed = parseSemanticCritique(rawOutput)
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.error,
      rawOutput,
    }
  }

  return {
    ok: true,
    value: parsed.value,
    rawOutput,
  }
}
