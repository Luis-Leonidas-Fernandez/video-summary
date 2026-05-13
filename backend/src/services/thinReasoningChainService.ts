import type { SemanticRichnessAssessment } from './semanticRichnessClassifier.js'
import { orchestrateThinReasoningAgents } from './thinReasoningAgentOrchestratorService.js'
export type { ReasoningPlan } from './reasoningPlanAgentService.js'
import type {
  EvidenceWindow,
  GroundedWindowExtraction,
  ThinReasoningEvalBundle,
} from './groundingTypes.js'
import type { ControlledRewriteTrace, ResolvedChangeSet } from './experimentalRewriteTypes.js'
import type { EvidenceDerivedPromptHints } from './evidenceDerivedPromptHintsService.js'

export interface ThinReasoningChainInput {
  window: EvidenceWindow
  originalExtraction: GroundedWindowExtraction
  allowedCitationIds: string[]
  assessment: SemanticRichnessAssessment
}

export type ThinReasoningChainResult =
  | {
      applied: true
      improved: true
      extraction: GroundedWindowExtraction
      rawOutput?: string
      planRawOutput?: string
      critiqueRawOutput?: string
      thinReasoningEvals?: ThinReasoningEvalBundle
      experimentalResolvedChangeSet?: ResolvedChangeSet
      experimentalControlledRewriteTrace?: ControlledRewriteTrace
      experimentalEvidenceHints?: EvidenceDerivedPromptHints
    }
  | {
      applied: true
      improved: false
      reason: string
      rawOutput?: string
      planRawOutput?: string
      critiqueRawOutput?: string
      parseError?: string
      thinReasoningEvals?: ThinReasoningEvalBundle
      experimentalResolvedChangeSet?: ResolvedChangeSet
      experimentalControlledRewriteTrace?: ControlledRewriteTrace
      experimentalEvidenceHints?: EvidenceDerivedPromptHints
    }
  | {
      applied: false
      reason: string
    }

export async function rewriteThinReasoningWithChainPrompts(
  input: ThinReasoningChainInput,
): Promise<ThinReasoningChainResult> {
  return orchestrateThinReasoningAgents(input)
}
