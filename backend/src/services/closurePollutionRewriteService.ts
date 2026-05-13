import { appConfig } from '../config.js'
import { completeOllamaResponse } from './ollamaClient.js'
import { renderEvidenceWindowMarkdown } from './evidenceWindowService.js'
import { buildWindowDraftExtractionJsonSchema, type JsonSchemaObject } from './outputSchemas.js'
import { sanitizeClosurePollutionWindow } from './semanticClosureSanitizerService.js'
import { assessSemanticRichness, type SemanticRichnessAssessment } from './semanticRichnessClassifier.js'
import { hasMaterialSemanticImprovement } from './semanticEnrichmentEvaluator.js'
import { normalizeDraftToGroundedExtraction, parseWindowDraftExtraction } from './windowDraftNormalizerService.js'
import type { EvidenceWindow, GroundedWindowExtraction } from './groundingTypes.js'

interface ClosureRewritePlan {
  doctrinalTopics: Array<{
    title: string
    mustKeep: string[]
    citations: string[]
  }>
  forbiddenPatterns: string[]
}

export interface ClosurePollutionRewriteInput {
  window: EvidenceWindow
  originalExtraction: GroundedWindowExtraction
  allowedCitationIds: string[]
  assessment: SemanticRichnessAssessment
}

export type ClosurePollutionRewriteResult =
  | {
      applied: true
      improved: true
      extraction: GroundedWindowExtraction
      rawOutput?: string
      planRawOutput?: string
    }
  | {
      applied: true
      improved: false
      reason: string
      rawOutput?: string
      planRawOutput?: string
      parseError?: string
    }
  | {
      applied: false
      reason: string
    }

function buildClosurePlanSchema(allowedCitationIds: string[]): JsonSchemaObject {
  const uniqueCitationIds = Array.from(new Set(allowedCitationIds.map((item) => item.trim()).filter(Boolean)))

  return {
    type: 'object',
    additionalProperties: false,
    required: ['doctrinalTopics', 'forbiddenPatterns'],
    properties: {
      doctrinalTopics: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'mustKeep', 'citations'],
          properties: {
            title: { type: 'string' },
            mustKeep: {
              type: 'array',
              minItems: 1,
              items: { type: 'string' },
            },
            citations: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'string',
                ...(uniqueCitationIds.length > 0 ? { enum: uniqueCitationIds } : {}),
              },
            },
          },
        },
      },
      forbiddenPatterns: {
        type: 'array',
        minItems: 1,
        items: { type: 'string' },
      },
    },
  }
}

function parseClosurePlan(rawOutput: string): { ok: true; value: ClosureRewritePlan } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(rawOutput) as Partial<ClosureRewritePlan>
    if (!Array.isArray(parsed.doctrinalTopics) || parsed.doctrinalTopics.length === 0) {
      return { ok: false, error: 'El plan de closure pollution no devolvió doctrinalTopics válidos.' }
    }

    const doctrinalTopics = parsed.doctrinalTopics
      .filter((item) =>
        item
        && typeof item.title === 'string'
        && Array.isArray(item.mustKeep)
        && Array.isArray(item.citations),
      )
      .map((item) => ({
        title: item.title,
        mustKeep: item.mustKeep.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
        citations: item.citations.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
      }))
      .filter((item) => item.mustKeep.length > 0 && item.citations.length > 0)

    if (doctrinalTopics.length === 0) {
      return { ok: false, error: 'El plan de closure pollution no devolvió doctrinalTopics utilizables.' }
    }

    return {
      ok: true,
      value: {
        doctrinalTopics,
        forbiddenPatterns: Array.isArray(parsed.forbiddenPatterns)
          ? parsed.forbiddenPatterns.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          : [],
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo parsear el plan de closure pollution.',
    }
  }
}

function isCallToActionBlock(block: { heading: string; content: string }): boolean {
  const combined = `${block.heading} ${block.content}`
  const hasCtaSignal = /suscrib[ií]|newsletter|bolet[ií]n|dale me gusta|canal de youtube|thanks for watching|see you in the next|remember to like|stay tuned|subscribe to my|descripci[oó]n.{0,30}(enlace|link)/i.test(combined)
  if (!hasCtaSignal) return false
  const hasSubstantiveContent = /\b(investigaci[oó]n|paper|modelo|capa|red neural|atenci[oó]n|residual|transformer|algoritm|arquitect|implement|técnic|tecnolog|concepto|argumento|teor[ií]a|m[eé]todo|principio|evidencia|afirmaci[oó]n|research|layer|network|neural|attention)\b/i.test(combined)
  return !hasSubstantiveContent
}

function stripCallToActionBlocks(extraction: GroundedWindowExtraction): GroundedWindowExtraction {
  const filtered = extraction.noteBlocks.filter(block => !isCallToActionBlock(block))
  if (filtered.length === extraction.noteBlocks.length) return extraction
  return { ...extraction, noteBlocks: filtered }
}

export async function rewriteClosurePollutionWindow(
  input: ClosurePollutionRewriteInput,
): Promise<ClosurePollutionRewriteResult> {
  if (!appConfig.enableChainSemanticEnrichment || !appConfig.enableClosureSanitizer) {
    return {
      applied: false,
      reason: 'El sanitizador de closure pollution está desactivado.',
    }
  }

  const ctaStripped = stripCallToActionBlocks(input.originalExtraction)
  const sanitized = sanitizeClosurePollutionWindow(input.window)

  const planSystem = [
    'Sos un analista grounded que separa contenido doctrinal de cierre conversacional.',
    'No redactes apuntes finales.',
    'Identificá solo el contenido doctrinal que debe conservarse y los patrones conversacionales que deben excluirse.',
    'Respondé únicamente con JSON válido.',
  ].join('\n')

  const planPrompt = [
    '<problem>',
    'La extracción actual quedó contaminada por closure_pollution.',
    '</problem>',
    '<rules>',
    'No conviertas saludos, despedidas, agradecimientos, invitaciones futuras, emails o referencias al canal en contenido doctrinal.',
    'Si un fragmento fue excluido por ser conversacional, solo usalo como patrón prohibido, no como contenido doctrinal.',
    '</rules>',
    '<current_extraction>',
    JSON.stringify(ctaStripped, null, 2),
    '</current_extraction>',
    '<forbidden_patterns>',
    ...(sanitized.excludedConversationalEvidence.length > 0
      ? sanitized.excludedConversationalEvidence.map((chunk) => `- ${chunk.text}`)
      : ['- saludos o cierres conversacionales']),
    '</forbidden_patterns>',
    '<evidence>',
    renderEvidenceWindowMarkdown(sanitized.window),
    '</evidence>',
  ].join('\n')

  const planRawOutput = await completeOllamaResponse({
    system: planSystem,
    prompt: planPrompt,
    maxContinuations: appConfig.maxChainSemanticEnrichmentAttempts,
    responseFormat: buildClosurePlanSchema(input.allowedCitationIds),
    profile: {
      numCtx: appConfig.fullNotesOllamaNumCtx,
      numPredict: appConfig.fullNotesOllamaNumPredict,
      keepAlive: appConfig.ollamaKeepAlive,
    },
  })

  const parsedPlan = parseClosurePlan(planRawOutput)
  if (!parsedPlan.ok) {
    return {
      applied: true,
      improved: false,
      reason: 'El paso A del rewrite de closure pollution no devolvió un plan usable.',
      parseError: parsedPlan.error,
      planRawOutput,
    }
  }

  const rewriteSystem = [
    'Sos un reescritor editorial grounded.',
    'Debés producir un WindowDraftExtraction doctrinal y limpio, usando solo evidencia útil.',
    'No inventes información nueva.',
    'No cambies el idioma.',
    'No agregues citas fuera del set permitido.',
    'No incluyas saludos, despedidas, agradecimientos, emails, referencias al canal ni invitaciones a seguir dialogando.',
    'Respondé únicamente con JSON válido.',
  ].join('\n')

  const rewritePrompt = [
    '<problem>',
    'Reescribí esta ventana corrigiendo closure_pollution.',
    '</problem>',
    '<rules>',
    'Conservá doctrina, objeciones, ejemplos y citas válidas.',
    'Eliminá todo patrón conversacional listado como prohibido.',
    'No expandas la salida por encima de lo que la evidencia doctrinal realmente sostiene.',
    '</rules>',
    '<plan>',
    JSON.stringify(parsedPlan.value, null, 2),
    '</plan>',
    '<current_extraction>',
    JSON.stringify(ctaStripped, null, 2),
    '</current_extraction>',
    '<examples>',
    JSON.stringify({
      items: [
        {
          title: 'Intercesión de los santos y ejemplos bíblicos',
          text: 'Se presentan ejemplos bíblicos de intercesión de justos ya fallecidos. El punto no es una despedida ni una invitación futura, sino la afirmación doctrinal de que la intercesión se considera posible también después de la muerte. La salida conserva solo el contenido teológico útil y descarta el cierre conversacional.',
          citations: ['C1', 'C2'],
        },
      ],
      insufficientEvidence: [],
    }, null, 2),
    '</examples>',
    '<forbidden_patterns>',
    ...(parsedPlan.value.forbiddenPatterns.length > 0 ? parsedPlan.value.forbiddenPatterns.map((item) => `- ${item}`) : ['- emails', '- invitaciones a continuar']),
    '</forbidden_patterns>',
    '<evidence>',
    renderEvidenceWindowMarkdown(sanitized.window),
    '</evidence>',
  ].join('\n')

  const rawOutput = await completeOllamaResponse({
    system: rewriteSystem,
    prompt: rewritePrompt,
    maxContinuations: appConfig.maxChainSemanticEnrichmentAttempts,
    responseFormat: buildWindowDraftExtractionJsonSchema(input.allowedCitationIds),
    profile: {
      numCtx: appConfig.fullNotesOllamaNumCtx,
      numPredict: appConfig.fullNotesOllamaNumPredict,
      keepAlive: appConfig.ollamaKeepAlive,
    },
  })

  const parsedDraft = parseWindowDraftExtraction(rawOutput, input.window.windowId, input.allowedCitationIds)
  if (!parsedDraft.ok) {
    return {
      applied: true,
      improved: false,
      reason: 'El paso B del rewrite de closure pollution no cumplió el schema draft.',
      parseError: parsedDraft.error,
      rawOutput,
      planRawOutput,
    }
  }

  const extraction = normalizeDraftToGroundedExtraction({
    draft: parsedDraft.value,
    windowId: input.window.windowId,
  })

  const ctaStrippedAssessment = assessSemanticRichness(ctaStripped, sanitized.window)
  const enrichedAssessment = assessSemanticRichness(extraction, sanitized.window)
  if (!hasMaterialSemanticImprovement({
    original: ctaStripped,
    enriched: extraction,
    originalAssessment: ctaStrippedAssessment,
    enrichedAssessment,
    targetFailureKind: 'closure_pollution',
  })) {
    return {
      applied: true,
      improved: false,
      reason: 'El rewrite de closure pollution no limpió suficientemente la ventana.',
      rawOutput,
      planRawOutput,
    }
  }

  return {
    applied: true,
    improved: true,
    extraction,
    rawOutput,
    planRawOutput,
  }
}
