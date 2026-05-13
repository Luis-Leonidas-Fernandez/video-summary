import { appConfig } from '../config.js'
import type {
  EvidenceWindow,
  GroundedWindowExtraction,
  WindowCompressionMetrics,
  WindowCoverageMetrics,
  WindowCoverageStatus,
  WindowExtractionStatus,
} from './groundingTypes.js'

function countWords(value: string): number {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

function resolveCompressionThreshold(inputWords: number): number {
  if (inputWords < 500) {
    return 0.70
  }

  if (inputWords < 900) {
    return 0.58
  }

  if (inputWords < 1200) {
    return 0.60
  }

  return 0.55
}

export function measureWindowCompression(extraction: GroundedWindowExtraction): WindowCompressionMetrics {
  const outputWords = countWords(extraction.noteBlocks.map((block) => block.content).join(' '))
  return {
    noteBlockCount: extraction.noteBlocks.length,
    outputWords,
  }
}

function classifyCoverageStatus({
  noteBlockCount,
  outputWords,
  inputWords,
  outputToInputRatio,
  integrityOk,
}: {
  noteBlockCount: number
  outputWords: number
  inputWords: number
  outputToInputRatio: number
  integrityOk: boolean
}): WindowCoverageStatus {
  if (!integrityOk) {
    return 'needs_review'
  }

  const compressionThreshold = resolveCompressionThreshold(inputWords)

  if (
    noteBlockCount < appConfig.minNoteBlocksPerWindow ||
    outputWords < appConfig.minWordsPerWindowExtraction ||
    outputToInputRatio < compressionThreshold
  ) {
    return 'too_compressed'
  }

  if (outputToInputRatio > 1.05) {
    return 'too_verbose'
  }

  if (outputToInputRatio >= 0.95) {
    return 'very_detailed'
  }

  return 'ok'
}

export function measureWindowCoverage({
  window,
  extraction,
  integrityOk,
}: {
  window: EvidenceWindow
  extraction: GroundedWindowExtraction
  integrityOk: boolean
}): WindowCoverageMetrics {
  const metrics = measureWindowCompression(extraction)
  const primaryChunks = window.evidence.filter((item) => item.role === 'primary')
  const inputWords = countWords((primaryChunks.length > 0 ? primaryChunks : window.evidence).map((item) => item.text).join(' '))
  const outputToInputRatio = inputWords > 0 ? Number((metrics.outputWords / inputWords).toFixed(3)) : 0
  const compressionThresholdApplied = resolveCompressionThreshold(inputWords)

  return {
    windowId: window.windowId,
    inputWords,
    outputWords: metrics.outputWords,
    outputToInputRatio,
    compressionThresholdApplied,
    noteBlocksCount: metrics.noteBlockCount,
    status: classifyCoverageStatus({
      noteBlockCount: metrics.noteBlockCount,
      outputWords: metrics.outputWords,
      inputWords,
      outputToInputRatio,
      integrityOk,
    }),
  }
}

export function classifyWindowCompression({
  window,
  extraction,
  integrityOk,
}: {
  window: EvidenceWindow
  extraction: GroundedWindowExtraction
  integrityOk: boolean
}): WindowExtractionStatus {
  const coverage = measureWindowCoverage({ window, extraction, integrityOk })

  if (coverage.status === 'too_compressed') {
    return 'too_compressed'
  }

  if (coverage.status === 'too_verbose') {
    return 'too_verbose'
  }

  if (coverage.status === 'very_detailed') {
    return 'very_detailed'
  }

  return coverage.status === 'needs_review' ? 'needs_human_review' : 'ok'
}
