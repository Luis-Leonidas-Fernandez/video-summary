export type ValidationStatus = 'accepted' | 'accepted_with_warnings' | 'repaired' | 'failed'

export type ValidationSignalType =
  | 'literal_match'
  | 'alias_match'
  | 'semantic_heading_match'
  | 'unmatched'
  | 'pattern_explosion'
  | 'artificial_taxonomy'

export type ValidationSignalSeverity = 'info' | 'warning' | 'strong'

export interface ValidationSignal {
  type: ValidationSignalType
  severity: ValidationSignalSeverity
  label: string
  reason: string
}

export interface ValidationMatch {
  label: string
  normalizedLabel: string
  matchType: 'literal_match' | 'alias_match' | 'semantic_heading_match' | 'unmatched'
  reason: string
}

export interface ValidationMetrics {
  headingCount: number
  unmatchedCount: number
  unmatchedRatio: number
  semanticMatchRatio: number
  strongDerivaDetected: boolean
}

export interface ValidationDecision {
  action: 'accept' | 'accept_with_warnings' | 'reject_or_repair'
  decisionReason: string
  warnings: string[]
  strongFlags: string[]
}

export interface ValidationResult {
  signals: ValidationSignal[]
  matches: ValidationMatch[]
  metrics: ValidationMetrics
  decision: ValidationDecision
}
