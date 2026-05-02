import {
  aggregateValidationMetrics,
  decideValidationOutcome,
} from './studyValidationDecision.js'
import {
  buildMatchSignals,
  detectStructuralSignals,
  extractLabels,
  matchLabel,
  normalizeText,
} from './studyValidationMatcher.js'
import type { ValidationResult } from './studyValidationTypes.js'

export type {
  ValidationDecision,
  ValidationMatch,
  ValidationMetrics,
  ValidationResult,
  ValidationSignal,
  ValidationStatus,
} from './studyValidationTypes.js'

export function validateExtractionContent({
  transcription,
  extraction,
}: {
  transcription: string
  extraction: string
}): ValidationResult {
  const normalizedSource = normalizeText(transcription)
  const labels = extractLabels(extraction)
  const matches = labels.map((label) => matchLabel(normalizedSource, label))
  const structuralSignals = detectStructuralSignals(extraction, normalizedSource)
  const signals = [...buildMatchSignals(matches), ...structuralSignals]
  const metrics = aggregateValidationMetrics(matches, signals)
  const decision = decideValidationOutcome(matches, signals, metrics)

  return {
    signals,
    matches,
    metrics,
    decision,
  }
}
