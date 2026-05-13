import type { EvidenceWindow, GroundedWindowExtraction, WindowOutputFailureKind } from './groundingTypes.js'
import { classifyWindowCompression } from './windowCompressionService.js'

export type SemanticRichnessFailureKind = Extract<
  WindowOutputFailureKind,
  'low_content' | 'thin_reasoning' | 'closure_pollution' | 'single_idea_collapse'
>

export interface SemanticRichnessAssessment {
  failureKind?: SemanticRichnessFailureKind
  missingSignals: string[]
  guidance: string[]
  totalWords: number
  averageWordsPerBlock: number
  reasoningRichBlocks: number
  evidenceSignals: ReturnType<typeof extractSignalSnapshot>
  extractionSignals: ReturnType<typeof extractSignalSnapshot>
  signalCounts: {
    causalBlocks: number
    contrastBlocks: number
    objectionBlocks: number
    exampleBlocks: number
    historicalBlocks: number
    closureBlocks: number
  }
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function hasClosurePollution(text: string): boolean {
  return /\bgracias(?!\s+a\b)|hasta luego|que est[eé]n muy bien|podemos seguir dialogando|quedo a disposici[oó]n|escribime|\bcorreo\b|email|suscrib[ií]rse|suscr[ií]bete|newsletter|bolet[ií]n|dale me gusta|canal de youtube|thanks for watching|see you in the next|remember to like|stay tuned/i.test(text)
}

function hasReasoningSignals(text: string): boolean {
  return /porque|por lo tanto|sin embargo|pero|aunque|esto implica|por ejemplo|objeci[oó]n|respuesta|en cambio|adem[aá]s|en consecuencia|lo que permite|esto genera|conlleva|resulta en|a pesar de|no obstante/i.test(text)
}

function hasCausalSignals(text: string): boolean {
  return /porque|por lo tanto|esto implica|por eso|de modo que|ya que|por ende|en consecuencia|lo que permite|esto genera|esto produce|esto provoca|resulta en|lleva a que|conlleva|lo que hace que|de donde se|de ah[ií] que/i.test(text)
}

function extractSignalSnapshot(text: string) {
  return {
    example: /\bejemplo|por ejemplo|analog[ií]a|imagina|igual que|viene a ser/i.test(text),
    contrast: /\bsin embargo|en cambio|aunque|pero\b|mientras que|ahora bien|a pesar de|no obstante|por el contrario/i.test(text),
    objection: /\bobjeci[oó]n|cr[ií]tica|pregunta|te dir[aá]n|podr[ií]a decirse/i.test(text),
    historical: /\bsiglo\b|tradici[oó]n|concilio|reforma|oriente|occidente/i.test(text),
    closure: hasClosurePollution(text),
  }
}

function hasMultipleThemes(extraction: GroundedWindowExtraction): boolean {
  const headings = new Set(extraction.noteBlocks.map((block) => block.heading.trim().toLowerCase()).filter(Boolean))
  return headings.size >= 3
}

function buildMissingSignals({
  evidenceText,
  extractionText,
}: {
  evidenceText: string
  extractionText: string
}): string[] {
  const evidenceSignals = extractSignalSnapshot(evidenceText)
  const extractionSignals = extractSignalSnapshot(extractionText)
  const missingSignals: string[] = []

  if (evidenceSignals.example && !extractionSignals.example) {
    missingSignals.push('Falta incorporar un ejemplo o analogía que sí aparece en la evidencia.')
  }
  if ((evidenceSignals.contrast || evidenceSignals.objection) && !(extractionSignals.contrast || extractionSignals.objection)) {
    missingSignals.push('Falta incorporar un contraste, objeción o respuesta presente en la evidencia.')
  }
  if (evidenceSignals.historical && !extractionSignals.historical) {
    missingSignals.push('Falta contexto histórico o tradicional que aparece explícitamente en la evidencia.')
  }

  return missingSignals
}

export function assessSemanticRichness(
  extraction: GroundedWindowExtraction,
  window?: EvidenceWindow,
): SemanticRichnessAssessment {
  if (extraction.noteBlocks.length === 0) {
    return {
      failureKind: undefined,
      missingSignals: [],
      guidance: [],
      totalWords: 0,
      averageWordsPerBlock: 0,
      reasoningRichBlocks: 0,
      evidenceSignals: extractSignalSnapshot(''),
      extractionSignals: extractSignalSnapshot(''),
      signalCounts: {
        causalBlocks: 0,
        contrastBlocks: 0,
        objectionBlocks: 0,
        exampleBlocks: 0,
        historicalBlocks: 0,
        closureBlocks: 0,
      },
    }
  }

  const combinedContent = extraction.noteBlocks.map((block) => block.content).join(' ')
  const evidenceText = window?.evidence.map((chunk) => chunk.text).join(' ') ?? ''
  const extractionSignals = extractSignalSnapshot(combinedContent)
  const evidenceSignals = extractSignalSnapshot(evidenceText)
  const missingSignals = buildMissingSignals({ evidenceText, extractionText: combinedContent })
  const totalWords = extraction.noteBlocks.reduce((sum, block) => sum + countWords(block.content), 0)
  const averageWordsPerBlock = totalWords / extraction.noteBlocks.length
  const reasoningRichBlocks = extraction.noteBlocks.filter((block) => {
    const sentences = splitSentences(block.content)
    return sentences.length >= 3 && hasReasoningSignals(block.content)
  }).length
  const signalCounts = extraction.noteBlocks.reduce((counts, block) => ({
    causalBlocks: counts.causalBlocks + (hasCausalSignals(block.content) ? 1 : 0),
    contrastBlocks: counts.contrastBlocks + (/\bsin embargo|en cambio|aunque|pero\b|mientras que|ahora bien|a pesar de|no obstante|por el contrario/i.test(block.content) ? 1 : 0),
    objectionBlocks: counts.objectionBlocks + (/\bobjeci[oó]n|cr[ií]tica|pregunta|te dir[aá]n|podr[ií]a decirse|respuesta\b/i.test(block.content) ? 1 : 0),
    exampleBlocks: counts.exampleBlocks + (/\bejemplo|por ejemplo|analog[ií]a|imagina|igual que|viene a ser/i.test(block.content) ? 1 : 0),
    historicalBlocks: counts.historicalBlocks + (/\bsiglo\b|tradici[oó]n|concilio|reforma|oriente|occidente/i.test(block.content) ? 1 : 0),
    closureBlocks: counts.closureBlocks + (hasClosurePollution(block.content) ? 1 : 0),
  }), {
    causalBlocks: 0,
    contrastBlocks: 0,
    objectionBlocks: 0,
    exampleBlocks: 0,
    historicalBlocks: 0,
    closureBlocks: 0,
  })

  let failureKind: SemanticRichnessFailureKind | undefined
  const guidance: string[] = []

  if (hasClosurePollution(combinedContent)) {
    failureKind = 'closure_pollution'
    guidance.push('Eliminá saludos, despedidas, agradecimientos y cualquier cierre conversacional.')
  } else if (totalWords < 140 || averageWordsPerBlock < 35) {
    failureKind = 'low_content'
    guidance.push('Expandí cada idea central con entre 3 y 5 oraciones si la evidencia lo permite.')
    guidance.push('No reduzcas la ventana a títulos o afirmaciones demasiado breves.')
  } else if (reasoningRichBlocks < Math.ceil(extraction.noteBlocks.length / 2)) {
    failureKind = 'thin_reasoning'
    guidance.push('Agregá desarrollo causal, contraste, objeciones o consecuencias cuando existan en la evidencia.')
  } else if (extraction.noteBlocks.length <= 2 && hasMultipleThemes(extraction)) {
    failureKind = 'single_idea_collapse'
    guidance.push('Separá los subtemas en items distintos en vez de colapsarlos en una sola idea.')
  } else if (window && classifyWindowCompression({ window, extraction, integrityOk: true }) === 'too_compressed') {
    failureKind = 'low_content'
    guidance.push('COBERTURA INSUFICIENTE: el texto generado cubre menos del 65% de la evidencia disponible. No hagas re-phrasing: agregá contenido real de la evidencia que no esté cubierto todavía.')
    guidance.push('Para cada item, revisá los chunks de evidencia y verificá si hay explicaciones, pasos, datos, secuencias o contexto que no está en el texto actual. Incorporalos.')
    guidance.push('Cada item debe tener entre 6 y 8 oraciones. Si ya tiene 5, agregá al menos 1-2 oraciones más con contenido de la evidencia.')
  }

  guidance.push(...missingSignals)

  return {
    failureKind,
    missingSignals,
    guidance,
    totalWords,
    averageWordsPerBlock,
    reasoningRichBlocks,
    evidenceSignals,
    extractionSignals,
    signalCounts,
  }
}

export function classifySemanticRichnessFailure(
  extraction: GroundedWindowExtraction,
  window?: EvidenceWindow,
): SemanticRichnessFailureKind | undefined {
  return assessSemanticRichness(extraction, window).failureKind
}
