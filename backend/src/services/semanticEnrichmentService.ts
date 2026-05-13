import { appConfig } from '../config.js'
import { jobLog } from '../utils/jobContext.js'
import { completeOllamaResponse } from './ollamaClient.js'
import { renderEvidenceWindowMarkdown } from './evidenceWindowService.js'
import type { EvidenceWindow, GroundedWindowExtraction } from './groundingTypes.js'
import { assessSemanticRichness, type SemanticRichnessAssessment } from './semanticRichnessClassifier.js'
import { buildSpeakerAwarenessPromptGuidance } from './speakerAwarenessService.js'
import { rewriteClosurePollutionWindow } from './closurePollutionRewriteService.js'
import { hasMaterialSemanticImprovement } from './semanticEnrichmentEvaluator.js'
import { rewriteThinReasoningWithChainPrompts } from './thinReasoningChainService.js'
import { normalizeDraftToGroundedExtraction, parseWindowDraftExtraction } from './windowDraftNormalizerService.js'
import { stripEditorialClosures } from './editorialClosureStripperService.js'
import { buildWindowDraftExtractionJsonSchema } from './outputSchemas.js'
import type { ControlledRewriteTrace, ResolvedChangeSet } from './experimentalRewriteTypes.js'
import type { EvidenceDerivedPromptHints } from './evidenceDerivedPromptHintsService.js'

export interface SemanticEnrichmentInput {
  window: EvidenceWindow
  originalExtraction: GroundedWindowExtraction
  allowedCitationIds: string[]
  failureKind: 'low_content' | 'thin_reasoning' | 'closure_pollution' | 'single_idea_collapse'
  assessment: SemanticRichnessAssessment
}

export type SemanticEnrichmentResult =
  | {
      applied: true
      improved: true
      extraction: GroundedWindowExtraction
      parseError?: string
      rawOutput?: string
      thinReasoningEvals?: import('./groundingTypes.js').ThinReasoningEvalBundle
      experimentalResolvedChangeSet?: ResolvedChangeSet
      experimentalControlledRewriteTrace?: ControlledRewriteTrace
      experimentalEvidenceHints?: EvidenceDerivedPromptHints
    }
  | {
      applied: true
      improved: false
      reason: string
      parseError?: string
      rawOutput?: string
      thinReasoningEvals?: import('./groundingTypes.js').ThinReasoningEvalBundle
      experimentalResolvedChangeSet?: ResolvedChangeSet
      experimentalControlledRewriteTrace?: ControlledRewriteTrace
      experimentalEvidenceHints?: EvidenceDerivedPromptHints
    }
  | {
      applied: false
      reason: string
    }

export async function enrichSemanticWindowExtraction(
  input: SemanticEnrichmentInput,
): Promise<SemanticEnrichmentResult> {
  if (!appConfig.enableSemanticEnrichment || appConfig.maxSemanticEnrichmentAttempts <= 0) {
    return {
      applied: false,
      reason: 'El enriquecimiento semántico está desactivado.',
    }
  }

  if (appConfig.generationSchemaMode !== 'simple_draft') {
    return {
      applied: false,
      reason: 'El enriquecimiento semántico solo está habilitado para simple_draft.',
    }
  }

  let persistentThinReasoningEvals: import('./groundingTypes.js').ThinReasoningEvalBundle | undefined
  let persistentExperimentalResolvedChangeSet: ResolvedChangeSet | undefined
  let persistentExperimentalControlledRewriteTrace: ControlledRewriteTrace | undefined
  let persistentExperimentalEvidenceHints: EvidenceDerivedPromptHints | undefined
  const speakerAwareGuidance = buildSpeakerAwarenessPromptGuidance(input.window)

  const primaryEvidenceWords = input.window.evidence
    .filter((c) => c.role === 'primary')
    .map((c) => c.text)
    .join(' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
  const currentExtractionWords = input.originalExtraction.noteBlocks
    .map((b) => b.content)
    .join(' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
  const targetExtractionWords = Math.ceil((primaryEvidenceWords > 0 ? primaryEvidenceWords : currentExtractionWords) * 0.65)
  const wordsNeeded = Math.max(0, targetExtractionWords - currentExtractionWords)

  if (input.failureKind === 'thin_reasoning') {
    const chained = await rewriteThinReasoningWithChainPrompts({
      window: input.window,
      originalExtraction: input.originalExtraction,
      allowedCitationIds: input.allowedCitationIds,
      assessment: input.assessment,
    })
    persistentThinReasoningEvals = chained.applied ? chained.thinReasoningEvals : undefined
    persistentExperimentalResolvedChangeSet = chained.applied ? chained.experimentalResolvedChangeSet : undefined
    persistentExperimentalControlledRewriteTrace = chained.applied ? chained.experimentalControlledRewriteTrace : undefined
    persistentExperimentalEvidenceHints = chained.applied ? chained.experimentalEvidenceHints : undefined

    if (chained.applied && chained.improved) {
      return {
        applied: true,
        improved: true,
        extraction: chained.extraction,
        rawOutput: chained.rawOutput,
        thinReasoningEvals: persistentThinReasoningEvals,
        experimentalResolvedChangeSet: persistentExperimentalResolvedChangeSet,
        experimentalControlledRewriteTrace: persistentExperimentalControlledRewriteTrace,
        experimentalEvidenceHints: persistentExperimentalEvidenceHints,
      }
    }
  }

  if (input.failureKind === 'closure_pollution') {
    const rewritten = await rewriteClosurePollutionWindow({
      window: input.window,
      originalExtraction: input.originalExtraction,
      allowedCitationIds: input.allowedCitationIds,
      assessment: input.assessment,
    })

    if (rewritten.applied && rewritten.improved) {
      return {
        applied: true,
        improved: true,
        extraction: rewritten.extraction,
        rawOutput: rewritten.rawOutput,
      }
    }
  }

  const system = [
    'Sos un enriquecedor semántico de apuntes grounded.',
    'Tu única tarea es reemitir la misma ventana con más riqueza semántica, usando exclusivamente la evidencia disponible.',
    'No agregues información nueva.',
    'No cambies el idioma.',
    'No cambies las citas por ids no permitidos.',
    'Respondé únicamente con JSON válido.',
    'PROHIBIDO cerrar items con frases que sinteticen o infieran más allá de lo que dice literalmente la evidencia.',
    'Si la evidencia contiene datos numéricos (segundos, tokens por segundo, precio, velocidad, porcentaje), incluilos en el texto del item. Omitirlos cuenta como thin_reasoning.',
    'Si la evidencia contiene una secuencia de razonamiento paso a paso, desarrollala en orden. No la comprimas en una frase.',
  ].join('\n')

  const prompt = [
    'Reemití esta extracción con mayor riqueza semántica sin salirte de la evidencia.',
    `Problema detectado: ${input.failureKind}.`,
    'Objetivo: más detalle, más matices, más objeciones/respuestas y más ejemplos si ya están en la evidencia.',
    ...(input.failureKind === 'low_content' ? [
      'REGLA DE ORO PARA low_content: el texto enriquecido DEBE tener MÁS palabras que el original, no menos. Nunca comprimas ni reduzcas items existentes. Solo podés agregar contenido. Si necesitás reescribir un item, el resultado debe ser más largo que el original.',
      `META DE COBERTURA: el texto actual tiene ${currentExtractionWords} palabras. La evidencia primaria tiene ${primaryEvidenceWords} palabras. La salida enriquecida debe tener AL MENOS ${targetExtractionWords} palabras totales. Necesitás agregar AL MENOS ${wordsNeeded} palabras de contenido real de la evidencia que no esté cubierto todavía.`,
    ] : []),
    'No cambies el idioma.',
    'No agregues información nueva. ACLARACIÓN: "no agregar información nueva" significa no inventar — podés y debés crear items nuevos cuando hay contenido ya presente en la evidencia que no está cubierto por ningún item de la extracción actual. Si un chunk contiene múltiples subtemas o eventos y la extracción actual solo cubre uno, creá items nuevos para los restantes.',
    'No uses ejemplos de dominio fijo. Si necesitás ilustrar forma, pensá en [afirmación principal], [límite], [evidencia], [consecuencia].',
    'No conviertas la salida en cierre conversacional.',
    'No incluyas saludos, despedidas, agradecimientos, emails ni promesas de continuidad.',
    'Cada item.text debe tener entre 5 y 8 oraciones cuando la evidencia lo permita. No comprimas a menos de 5 oraciones un concepto que la evidencia desarrolla con más detalle.',
    'Si hay objeción, contraste, ejemplo o contexto histórico en la evidencia, no lo omitas.',
    ...speakerAwareGuidance,
    'Mantené únicamente citas permitidas.',
    'No reduzcas toda la ventana a una sola idea.',
    'Si la extracción tiene items que colapsan fases o subtemas distintos de un chunk, separá esas fases en items propios.',
    'Cuando un item cubre un test o comparación entre múltiples actores, todos los actores evaluados deben aparecer en ese mismo item con su resultado específico. No cubras solo al ganador y omitas los demás.',
    'No crees items redundantes. Cada item nuevo debe cubrir contenido que no aparece en ningún otro item de la extracción.',
    '',
    'PROHIBICIONES ESPECÍFICAS — violación descalifica el item:',
    '- La última oración de cada item.text NO puede ser un resumen editorial ni una conclusión inferida.',
    '- Patrones de cierre PROHIBIDOS — cualquiera de estas formas descalifica el item:',
    '    Oraciones que empiecen con "Esto", "Esta", "Ello", "Eso" y sinteticen el párrafo anterior.',
    '    Oraciones que empiecen con "Por lo tanto", "Por ende", "En consecuencia", "Así que", "De este modo".',
    '    Oraciones que contengan "lo que sugiere que", "lo que indica que", "lo que demuestra que".',
    '    Oraciones que contengan "es importante considerar", "es crucial", "es fundamental" como editorialización.',
    '- ANCLA POSITIVA — la última oración debe ser un hecho, dato o contraste extraído literalmente de la evidencia:',
    '    CORRECTO:   "[Dato concreto de la evidencia] [cita]."',
    '    INCORRECTO: "Por lo tanto, X es el mejor enfoque."',
    '    INCORRECTO: "Esto demuestra la importancia de Y."',
    '    INCORRECTO: "Lo que sugiere que se debe considerar Z."',
    '    Si no hay más contenido grounded para agregar, terminá en la oración anterior — no agregues una de cierre.',
    '- Si la evidencia tiene datos numéricos (tiempo en segundos, tokens/s, precio, velocidad relativa), incluilos. Si los omitís, el item sigue siendo thin_reasoning.',
    '- Si la evidencia tiene una secuencia de razonamiento paso a paso, desarrollala con los pasos en orden. No la comprimas.',
    '',
    'Ejemplos de cierre editorial PROHIBIDO:',
    '  BAD:  "El modelo A resolvió el problema en un solo intento [C1]. Este resultado sugiere una mayor eficiencia y adaptabilidad de A para este escenario."',
    '  WHY:  La segunda oración es inferencia editorial. "Este resultado sugiere" no está en la evidencia. Está prohibida.',
    '  GOOD: "El modelo A resolvió el problema en un solo intento [C1]. El modelo B eventualmente llegó al resultado pero requirió prompts adicionales [C1]. El modelo C no pudo responder porque su entrenamiento no cubría ese período [C2]."',
    '  WHY:  Las tres oraciones son hechos directos de la evidencia. No infieren. No sintetizan.',
    '',
    '  BAD:  "[Descripción de un resultado] [C1]. Esta analogía sugiere que X es un buen punto de partida para la experimentación."',
    '  WHY:  "Esta analogía sugiere" es síntesis. No aparece literalmente en la evidencia.',
    '  GOOD: "[Descripción de un resultado] [C1]. [Siguiente hecho de la evidencia] [C1]."',
    '  WHY:  Si no hay más contenido grounded, terminá antes — no agregues cierre.',
    '  ADVERTENCIA: Los valores entre corchetes son placeholders ficticios para ilustrar el patrón. Solo usá valores que existan literalmente en la evidencia provista.',
    '',
    'Qué faltó específicamente en la extracción actual:',
    ...(input.assessment.guidance.length > 0
      ? input.assessment.guidance.map((item) => `- ${item}`)
      : ['- Agregá más desarrollo argumental sin salirte de la evidencia.']),
    '',
    'Schema obligatorio:',
    '{',
    '  "items": [',
    '    {',
    '      "title": "string",',
    '      "text": "string",',
    '      "citations": ["C1"]',
    '    }',
    '  ],',
    '  "insufficientEvidence": [',
    '    {',
    '      "claim": "string",',
    '      "reason": "string"',
    '    }',
    '  ]',
    '}',
    '',
    'REGLA CRÍTICA — insufficientEvidence:',
    'Si una afirmación no puede sustentarse con la evidencia provista, ponela ÚNICAMENTE en el array "insufficientEvidence".',
    'NUNCA la incluyas como un item en "items". El array "items" es exclusivamente para contenido respaldado directamente por la evidencia.',
    'El array "insufficientEvidence" puede estar vacío — solo usarlo cuando realmente falte evidencia.',
    '',
    'Ejemplos buenos de riqueza semántica:',
    '{',
    '  "items": [',
    '    {',
    '      "title": "[subtema principal]",',
    '      "text": "Se explica [afirmación principal]. El contraste u objeción se vuelve explícito porque la evidencia ya sugiere [límite o diferencia], sin introducir conceptos externos al contenido actual.",',
    '      "citations": ["C1", "C2"]',
    '    }',
    '  ],',
    '  "insufficientEvidence": []',
    '}',
    '{',
    '  "items": [',
    '    {',
    '      "title": "[subtema con objeción y respuesta]",',
    '      "text": "Se presenta [objeción o límite] y luego se responde con una aclaración grounded por la evidencia. El texto deja explícita la relación entre el problema detectado y la respuesta sugerida, sin cambiar la tesis original.",',
    '      "citations": ["C2", "C3"]',
    '    }',
    '  ],',
    '  "insufficientEvidence": []',
    '}',
    '{',
    '  "items": [',
    '    {',
    '      "title": "[caso o ejemplo mencionado]",',
    '      "text": "Se desarrolla un caso concreto o ejemplo ya presente en la evidencia. El ejemplo no reemplaza el argumento principal, pero lo ilustra sin agregar analogías nuevas ajenas al contenido disponible.",',
    '      "citations": ["C3"]',
    '    }',
    '  ],',
    '  "insufficientEvidence": []',
    '}',
    '',
    'Extracción actual (demasiado pobre, solo para mejorarla sin salirte de la evidencia):',
    JSON.stringify(input.originalExtraction, null, 2),
    '',
    renderEvidenceWindowMarkdown(input.window),
  ].join('\n')

  const rawOutput = await completeOllamaResponse({
    system,
    prompt,
    maxContinuations: appConfig.maxSemanticEnrichmentAttempts,
    responseFormat: buildWindowDraftExtractionJsonSchema(input.allowedCitationIds),
    profile: {
      numCtx: appConfig.fullNotesOllamaNumCtx,
      numPredict: appConfig.fullNotesOllamaNumPredict,
      keepAlive: appConfig.ollamaKeepAlive,
    },
    debugLabel: `enrichment:${input.failureKind}:${input.window.windowId}`,
  })

  const parsed = parseWindowDraftExtraction(rawOutput, input.window.windowId, input.allowedCitationIds)
  if (!parsed.ok) {
    jobLog(`[enrichment:parse-error] windowId=${input.window.windowId} failureKind=${input.failureKind} error=${parsed.error} rawLength=${rawOutput.length}`)
    return {
      applied: true,
      improved: false,
      reason: 'La salida enriquecida no cumplió el schema draft.',
      parseError: parsed.error,
      rawOutput,
      thinReasoningEvals: persistentThinReasoningEvals,
      experimentalResolvedChangeSet: persistentExperimentalResolvedChangeSet,
      experimentalControlledRewriteTrace: persistentExperimentalControlledRewriteTrace,
      experimentalEvidenceHints: persistentExperimentalEvidenceHints,
    }
  }

  const rawExtraction = normalizeDraftToGroundedExtraction({
    draft: parsed.value,
    windowId: input.window.windowId,
  })

  const strippedExtraction = normalizeDraftToGroundedExtraction({
    draft: stripEditorialClosures(parsed.value),
    windowId: input.window.windowId,
  })

  const enrichedAssessment = assessSemanticRichness(rawExtraction, input.window)

  const semanticImproved = hasMaterialSemanticImprovement({
    original: input.originalExtraction,
    enriched: rawExtraction,
    originalAssessment: input.assessment,
    enrichedAssessment,
    targetFailureKind: input.failureKind,
  })
  jobLog(`[enrichment-result] windowId=${input.window.windowId} failureKind=${input.failureKind} improved=${semanticImproved} enrichedFailureKind=${enrichedAssessment.failureKind ?? 'none'}`)

  if (!semanticImproved) {
    return {
      applied: true,
      improved: false,
      reason: 'La versión enriquecida no mejoró materialmente la riqueza semántica.',
      rawOutput,
      thinReasoningEvals: persistentThinReasoningEvals,
      experimentalResolvedChangeSet: persistentExperimentalResolvedChangeSet,
      experimentalControlledRewriteTrace: persistentExperimentalControlledRewriteTrace,
      experimentalEvidenceHints: persistentExperimentalEvidenceHints,
    }
  }

  return {
    applied: true,
    improved: true,
    extraction: strippedExtraction,
    rawOutput,
    thinReasoningEvals: persistentThinReasoningEvals,
    experimentalResolvedChangeSet: persistentExperimentalResolvedChangeSet,
    experimentalControlledRewriteTrace: persistentExperimentalControlledRewriteTrace,
    experimentalEvidenceHints: persistentExperimentalEvidenceHints,
  }
}
