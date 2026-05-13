import type { GroundedWindowExtraction, ReasoningSignal, ThinReasoningEvalResult } from './groundingTypes.js'
import type { EvidenceDerivedPromptHints } from './evidenceDerivedPromptHintsService.js'

export type ResolvedChangeType =
  | 'clarify'
  | 'make_explicit'
  | 'reorder'
  | 'add_contrast'
  | 'add_objection'
  | 'add_response'
  | 'add_example'
  | 'restore_existing_signal'
  | 'expand_why_it_matters'
  | 'expand_causal_link'
  | 'expand_consequence'
  | 'expand_evidence_binding'
  | 'increase_argument_density'

export type OperationScope =
  | 'item_text_only'
  | 'item_title'
  | 'item_citations'
  | 'section_order'

export type ExpectedEffect =
  | 'preserve_signal'
  | 'increase_argument_density'
  | 'improve_causal_link'
  | 'clarify_objection'
  | 'improve_evidence_binding'

export interface MinimalEvidenceQuote {
  evidenceQuoteId: string
  citationId: string
  text: string
  chunkId?: string
}

export interface ResolvedChange {
  changeId: string
  targetSection: string
  changeType: ResolvedChangeType
  operationScope: OperationScope
  instruction: string
  expectedEffect: ExpectedEffect
  citationsUsed: string[]
  evidenceQuoteIds: string[]
  protectedSignals: Array<'contrast' | 'objection' | 'response' | 'example'>
  targetLostSignals: Array<'contrast' | 'objection' | 'response' | 'example'>
  minimumRewriteRequirement: string
  unsafeIfUnsupported: boolean
}

export interface ResolvedChangeSet {
  status: 'ok' | 'no_safe_changes'
  changes: ResolvedChange[]
  rawResolvedChangeCount?: number
  finalResolvedChangeCount?: number
  groundingRejectedChangeIds?: string[]
  groundingRejectedReasons?: Array<{
    changeId: string
    reason: 'instruction_out_of_evidence' | 'cross_domain_terms_not_supported'
    severity?: 'warn' | 'reject'
    unsupportedTerms?: string[]
  }>
  policyDroppedChangeIds?: string[]
  policyDroppedReasons?: Array<{
    changeId: string
    reason:
      | 'max_expansions_per_window'
      | 'max_expansions_per_item'
      | 'lower_priority_expansion'
  }>
}

export interface ControlledRewriteTrace {
  appliedChanges: ControlledAppliedChange[]
  rejectedChanges: Array<{
    changeId: string
    reason: string
  }>
}

export interface ControlledAppliedChangeMarker {
  changeId: string
  applied: boolean
}

export interface ControlledAppliedChange {
  changeId: string
  applied: boolean
  minimumRequirementSatisfied: boolean
  restoredSignals: Array<'contrast' | 'objection' | 'response' | 'example'>
  ineffectiveReason?:
    | 'target_signal_not_restored'
    | 'minimum_requirement_not_met'
    | 'final_eval_still_reports_signal_lost'
    | 'unsupported_by_evidence'
    | 'too_weak'
    | 'changed_meaning'
}

export interface ControlledRewriteResult {
  rewrittenExtraction: GroundedWindowExtraction
  appliedChanges: ControlledAppliedChangeMarker[]
  rejectedChanges: Array<{
    changeId: string
    reason: string
  }>
}

export interface SignalPreservationVerifierInput {
  originalExtraction: GroundedWindowExtraction
  rewrittenExtraction: GroundedWindowExtraction
  protectedSignals: Array<'contrast' | 'objection' | 'response' | 'example'>
  resolvedChanges: ResolvedChangeSet
  minimalEvidence: MinimalEvidenceQuote[]
  appliedChanges: ControlledAppliedChangeMarker[]
}

export interface SignalPreservationVerifierResult {
  signalIntegrityOk: boolean
  lostSignals: Array<'contrast' | 'objection' | 'response' | 'example'>
  reason: string
  unsafeAppliedChanges: string[]
  appliedChangeOutcomes: ControlledAppliedChange[]
}

export interface ExperimentalRewriteExecutionMetadata {
  resolveRan: boolean
  rewriteControlledRan: boolean
  resolvedChangeCount: number
  appliedChangeCount: number
  effectiveAppliedChangeCount: number
  effectiveTargetSignalRestoreCount: number
  rejectedChangeCount: number
  experimentalRewriteAccepted: boolean
}

export type ExperimentalRewriteResult =
  | {
      applied: false
      reason: string
      execution: ExperimentalRewriteExecutionMetadata
      resolvedChangeSet?: ResolvedChangeSet
      controlledRewriteTrace?: ControlledRewriteTrace
      evidenceHints?: EvidenceDerivedPromptHints
    }
  | {
      applied: true
      improved: true
      extraction: GroundedWindowExtraction
      resolvedChangeSet: ResolvedChangeSet
      controlledRewriteTrace: ControlledRewriteTrace
      rewriteEval: ThinReasoningEvalResult
      evidenceHints?: EvidenceDerivedPromptHints
      rawOutput?: string
      resolveRawOutput?: string
      rewriteControlledRawOutput?: string
      execution: ExperimentalRewriteExecutionMetadata
    }
  | {
      applied: true
      improved: false
      reason: string
      resolvedChangeSet?: ResolvedChangeSet
      controlledRewriteTrace?: ControlledRewriteTrace
      rewriteEval?: ThinReasoningEvalResult
      evidenceHints?: EvidenceDerivedPromptHints
      rawOutput?: string
      resolveRawOutput?: string
      rewriteControlledRawOutput?: string
      execution: ExperimentalRewriteExecutionMetadata
    }
