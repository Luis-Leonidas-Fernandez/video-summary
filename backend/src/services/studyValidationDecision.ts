import type {
  ValidationDecision,
  ValidationMatch,
  ValidationMetrics,
  ValidationSignal,
} from './studyValidationTypes.js'

function roundMetric(value: number): number {
  return Number(value.toFixed(3))
}

export function aggregateValidationMetrics(matches: ValidationMatch[], signals: ValidationSignal[]): ValidationMetrics {
  const headingCount = matches.length
  const unmatchedCount = matches.filter((match) => match.matchType === 'unmatched').length
  const semanticLikeCount = matches.filter((match) => match.matchType !== 'unmatched').length
  const unmatchedRatio = headingCount === 0 ? 0 : unmatchedCount / headingCount
  const semanticMatchRatio = headingCount === 0 ? 1 : semanticLikeCount / headingCount
  const strongDerivaDetected = signals.some((signal) => signal.severity === 'strong')

  return {
    headingCount,
    unmatchedCount,
    unmatchedRatio: roundMetric(unmatchedRatio),
    semanticMatchRatio: roundMetric(semanticMatchRatio),
    strongDerivaDetected,
  }
}

export function decideValidationOutcome(matches: ValidationMatch[], signals: ValidationSignal[], metrics: ValidationMetrics): ValidationDecision {
  const warnings = new Set<string>()
  const strongFlags = new Set<string>()

  for (const signal of signals) {
    if (signal.severity === 'strong') {
      strongFlags.add(signal.type)
      continue
    }

    if (signal.type === 'unmatched') {
      warnings.add('possible_paraphrase_detected')
    }
  }

  if (metrics.strongDerivaDetected) {
    return {
      action: 'reject_or_repair',
      decisionReason: 'Se detectó deriva estructural fuerte; corresponde reparar o rechazar la extracción.',
      warnings: [...warnings],
      strongFlags: [...strongFlags],
    }
  }

  const rejectForAccumulatedUnmatched =
    metrics.unmatchedCount >= 5 &&
    metrics.unmatchedRatio > 0.4 &&
    metrics.semanticMatchRatio < 0.6

  if (rejectForAccumulatedUnmatched) {
    strongFlags.add('absent_entity_detected')
    return {
      action: 'reject_or_repair',
      decisionReason: `${metrics.unmatchedCount} labels unmatched superan el umbral acumulativo y el soporte semántico es insuficiente.`,
      warnings: [...warnings],
      strongFlags: [...strongFlags],
    }
  }

  if (metrics.unmatchedCount > 0) {
    return {
      action: 'accept_with_warnings',
      decisionReason: `${metrics.unmatchedCount} labels unmatched, por debajo del umbral de rechazo; no se detectó deriva fuerte.`,
      warnings: [...new Set([...warnings, 'possible_paraphrase_detected'])],
      strongFlags: [...strongFlags],
    }
  }

  return {
    action: 'accept',
    decisionReason: 'Todos los labels quedaron cubiertos por match literal, alias o heading semántico; no se detectó deriva fuerte.',
    warnings: [...warnings],
    strongFlags: [...strongFlags],
  }
}
