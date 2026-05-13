import { jobLog } from '../utils/jobContext.js'
import type { GroundedWindowExtraction } from './groundingTypes.js'
import type { SemanticRichnessAssessment } from './semanticRichnessClassifier.js'

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export function hasMaterialSemanticImprovement({
  original,
  enriched,
  originalAssessment,
  enrichedAssessment,
  targetFailureKind,
}: {
  original: GroundedWindowExtraction
  enriched: GroundedWindowExtraction
  originalAssessment: SemanticRichnessAssessment
  enrichedAssessment: SemanticRichnessAssessment
  targetFailureKind?: SemanticRichnessAssessment['failureKind']
}): boolean {
  const originalWords = countWords(original.noteBlocks.map((block) => block.content).join(' '))
  const enrichedWords = countWords(enriched.noteBlocks.map((block) => block.content).join(' '))
  const wordGain = enrichedWords - originalWords
  const blockGain = enriched.noteBlocks.length - original.noteBlocks.length
  const missingSignalsReduced = enrichedAssessment.missingSignals.length < originalAssessment.missingSignals.length
  const failureResolved = !enrichedAssessment.failureKind || enrichedAssessment.failureKind !== originalAssessment.failureKind
  const closureRemoved = originalAssessment.failureKind === 'closure_pollution' && enrichedAssessment.failureKind !== 'closure_pollution'

  if (targetFailureKind === 'closure_pollution') {
    if (closureRemoved && enrichedWords >= originalWords) {
      return true
    }

    const introducedUnsupportedSignals = (
      (!originalAssessment.evidenceSignals.objection && enrichedAssessment.extractionSignals.objection)
      || (!originalAssessment.evidenceSignals.historical && enrichedAssessment.extractionSignals.historical)
      || (!originalAssessment.evidenceSignals.example && enrichedAssessment.extractionSignals.example)
    )

    if (introducedUnsupportedSignals) {
      return false
    }

    const closureBlocksReduced = enrichedAssessment.signalCounts.closureBlocks < originalAssessment.signalCounts.closureBlocks
    const notTooVerbose = enrichedWords <= originalWords + 140
    return closureBlocksReduced && notTooVerbose && !enrichedAssessment.extractionSignals.closure
  }

  if (targetFailureKind === 'low_content') {
    const introducedThinReasoning = enrichedAssessment.failureKind === 'thin_reasoning'
    jobLog(`[enrichment-eval:low_content] windowId=${enriched.windowId} wordGain=${wordGain} blockGain=${blockGain} failureResolved=${failureResolved} missingSignalsReduced=${missingSignalsReduced} introducedThinReasoning=${introducedThinReasoning} blocks:${original.noteBlocks.length}→${enriched.noteBlocks.length} words:${originalWords}→${enrichedWords}`)

    if (introducedThinReasoning && !failureResolved) {
      return false
    }

    if (wordGain < 0) {
      return false
    }

    return (
      enriched.noteBlocks.length >= original.noteBlocks.length - 1
      && (
        wordGain >= 40
        || failureResolved
        || (blockGain > 0 && wordGain >= 0)
        || (missingSignalsReduced && wordGain >= 0)
      )
    )
  }

  if (targetFailureKind === 'thin_reasoning') {
    const introducedUnsupportedHistorical = (
      !originalAssessment.evidenceSignals.historical
      && enrichedAssessment.extractionSignals.historical
    )
    const introducedUnsupportedExample = (
      !originalAssessment.evidenceSignals.example
      && enrichedAssessment.extractionSignals.example
    )

    if (introducedUnsupportedHistorical || introducedUnsupportedExample) {
      jobLog(`[enrichment-eval:thin_reasoning] REJECTED early — introducedUnsupportedHistorical=${introducedUnsupportedHistorical} introducedUnsupportedExample=${introducedUnsupportedExample} evidenceHist=${originalAssessment.evidenceSignals.historical} evidenceEx=${originalAssessment.evidenceSignals.example} enrichedHist=${enrichedAssessment.extractionSignals.historical} enrichedEx=${enrichedAssessment.extractionSignals.example}`)
      return false
    }

    const argumentDensityImproved = (
      enrichedAssessment.signalCounts.causalBlocks > originalAssessment.signalCounts.causalBlocks
      || enrichedAssessment.signalCounts.contrastBlocks > originalAssessment.signalCounts.contrastBlocks
      || enrichedAssessment.signalCounts.objectionBlocks > originalAssessment.signalCounts.objectionBlocks
      || (
        originalAssessment.evidenceSignals.example
        && enrichedAssessment.signalCounts.exampleBlocks > originalAssessment.signalCounts.exampleBlocks
      )
      || (
        originalAssessment.evidenceSignals.historical
        && enrichedAssessment.signalCounts.historicalBlocks > originalAssessment.signalCounts.historicalBlocks
      )
      || enrichedAssessment.reasoningRichBlocks > originalAssessment.reasoningRichBlocks
    )

    const signalCountImproved = (
      enrichedAssessment.signalCounts.causalBlocks > originalAssessment.signalCounts.causalBlocks
      || enrichedAssessment.signalCounts.contrastBlocks > originalAssessment.signalCounts.contrastBlocks
      || enrichedAssessment.signalCounts.objectionBlocks > originalAssessment.signalCounts.objectionBlocks
    )

    jobLog(`[enrichment-eval:thin_reasoning] windowId=${enriched.windowId} wordGain=${wordGain} blockGain=${blockGain} argumentDensityImproved=${argumentDensityImproved} signalCountImproved=${signalCountImproved} failureResolved=${failureResolved} missingSignalsReduced=${missingSignalsReduced} reasoningRich:${originalAssessment.reasoningRichBlocks}→${enrichedAssessment.reasoningRichBlocks} causal:${originalAssessment.signalCounts.causalBlocks}→${enrichedAssessment.signalCounts.causalBlocks} contrast:${originalAssessment.signalCounts.contrastBlocks}→${enrichedAssessment.signalCounts.contrastBlocks} avgWords:${originalAssessment.averageWordsPerBlock.toFixed(1)}→${enrichedAssessment.averageWordsPerBlock.toFixed(1)} blocks:${original.noteBlocks.length}→${enriched.noteBlocks.length}`)

    if (!argumentDensityImproved && wordGain < 40) {
      return false
    }

    return (
      enriched.noteBlocks.length >= original.noteBlocks.length - 1
      && (
        (!argumentDensityImproved && wordGain >= 40)
        || (failureResolved && argumentDensityImproved && wordGain >= -30)
        || (failureResolved && wordGain >= 0)
        || (missingSignalsReduced && wordGain >= 20)
        || (enrichedAssessment.reasoningRichBlocks > originalAssessment.reasoningRichBlocks && wordGain >= 0)
        || (enrichedAssessment.averageWordsPerBlock >= originalAssessment.averageWordsPerBlock + 8 && wordGain >= 10)
        || (blockGain > 0 && wordGain >= 10)
        || (signalCountImproved && wordGain >= 15)
      )
    )
  }

  return (
    enriched.noteBlocks.length >= original.noteBlocks.length
    && (
      (wordGain >= 30 && failureResolved)
      || (wordGain >= 45 && missingSignalsReduced)
      || (wordGain >= 60)
      || (blockGain > 0 && missingSignalsReduced)
    )
  )
}
