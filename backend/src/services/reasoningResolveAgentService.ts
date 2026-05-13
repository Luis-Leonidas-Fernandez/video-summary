import { appConfig } from '../config.js'
import { completeOllamaResponse } from './ollamaClient.js'
import { buildEvidenceDerivedPromptHints, type EvidenceDerivedPromptHints } from './evidenceDerivedPromptHintsService.js'
import type { JsonSchemaObject } from './outputSchemas.js'
import type { GroundedWindowExtraction, ReasoningSignal } from './groundingTypes.js'
import type { ReasoningPlan } from './reasoningPlanAgentService.js'
import type { SemanticCritique } from './semanticCritiqueService.js'
import type { ExpectedEffect, MinimalEvidenceQuote, OperationScope, ResolvedChange, ResolvedChangeSet, ResolvedChangeType } from './experimentalRewriteTypes.js'

export interface ReasoningResolveAgentInput {
  originalExtraction: GroundedWindowExtraction
  plan: ReasoningPlan
  critique: SemanticCritique
  minimalEvidence: MinimalEvidenceQuote[]
  evidenceHints?: EvidenceDerivedPromptHints
}

type RestoreSignal = 'contrast' | 'objection' | 'response' | 'example'

const MAX_EXPANSION_CHANGES_PER_WINDOW = 2
const MAX_EXPANSION_CHANGES_PER_ITEM = 1
const MAX_RESTORE_CHANGES_PER_WINDOW = 2
const EXPANSION_CHANGE_TYPES = new Set<ResolvedChangeType>([
  'expand_evidence_binding',
  'expand_causal_link',
  'expand_why_it_matters',
  'expand_consequence',
  'increase_argument_density',
])

function buildResolvedChangeSchema(allowedCitationIds: string[], evidenceQuoteIds: string[]): JsonSchemaObject {
  const uniqueCitationIds = Array.from(new Set(allowedCitationIds.map((item) => item.trim()).filter(Boolean)))
  const uniqueEvidenceQuoteIds = Array.from(new Set(evidenceQuoteIds.map((item) => item.trim()).filter(Boolean)))
  const signalEnum: ReasoningSignal[] = ['contrast', 'objection', 'response', 'example', 'historical_context', 'causal']
  const protectedSignalEnum = ['contrast', 'objection', 'response', 'example'] as const
  const changeTypeEnum: ResolvedChangeType[] = ['clarify', 'make_explicit', 'reorder', 'add_contrast', 'add_objection', 'add_response', 'add_example', 'restore_existing_signal', 'expand_why_it_matters', 'expand_causal_link', 'expand_consequence', 'expand_evidence_binding', 'increase_argument_density']
  const operationScopeEnum: OperationScope[] = ['item_text_only', 'item_title', 'item_citations', 'section_order']
  const expectedEffectEnum: ExpectedEffect[] = ['preserve_signal', 'increase_argument_density', 'improve_causal_link', 'clarify_objection', 'improve_evidence_binding']

  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'changes'],
    properties: {
      status: {
        type: 'string',
        enum: ['ok', 'no_safe_changes'],
      },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['changeId', 'targetSection', 'changeType', 'operationScope', 'instruction', 'expectedEffect', 'citationsUsed', 'evidenceQuoteIds', 'protectedSignals', 'targetLostSignals', 'minimumRewriteRequirement', 'unsafeIfUnsupported'],
          properties: {
            changeId: { type: 'string' },
            targetSection: { type: 'string' },
            changeType: { type: 'string', enum: changeTypeEnum },
            operationScope: { type: 'string', enum: operationScopeEnum },
            instruction: { type: 'string' },
            expectedEffect: { type: 'string', enum: expectedEffectEnum },
            citationsUsed: {
              type: 'array',
              items: {
                type: 'string',
                ...(uniqueCitationIds.length > 0 ? { enum: uniqueCitationIds } : {}),
              },
            },
            evidenceQuoteIds: {
              type: 'array',
              items: {
                type: 'string',
                ...(uniqueEvidenceQuoteIds.length > 0 ? { enum: uniqueEvidenceQuoteIds } : {}),
              },
            },
            protectedSignals: {
              type: 'array',
              items: {
                type: 'string',
                enum: protectedSignalEnum,
              },
            },
            targetLostSignals: {
              type: 'array',
              items: {
                type: 'string',
                enum: protectedSignalEnum,
              },
            },
            minimumRewriteRequirement: { type: 'string' },
            unsafeIfUnsupported: { type: 'boolean' },
          },
        },
      },
    },
  }
}

function normalizeSignals(values: unknown): ReasoningSignal[] {
  const allowed: ReasoningSignal[] = ['contrast', 'objection', 'response', 'example', 'historical_context', 'causal']
  if (!Array.isArray(values)) {
    return []
  }
  return values.filter((value): value is ReasoningSignal => typeof value === 'string' && allowed.includes(value as ReasoningSignal))
}

function normalizeProtectedSignals(values: unknown): Array<'contrast' | 'objection' | 'response' | 'example'> {
  const allowed = ['contrast', 'objection', 'response', 'example'] as const
  if (!Array.isArray(values)) {
    return []
  }
  return values.filter((value): value is (typeof allowed)[number] => typeof value === 'string' && (allowed as readonly string[]).includes(value))
}

function parseResolvedChangeType(value: unknown): ResolvedChangeType | null {
  const allowed: ResolvedChangeType[] = ['clarify', 'make_explicit', 'reorder', 'add_contrast', 'add_objection', 'add_response', 'add_example', 'restore_existing_signal', 'expand_why_it_matters', 'expand_causal_link', 'expand_consequence', 'expand_evidence_binding', 'increase_argument_density']
  return typeof value === 'string' && allowed.includes(value as ResolvedChangeType) ? value as ResolvedChangeType : null
}

function parseOperationScope(value: unknown): OperationScope | null {
  const allowed: OperationScope[] = ['item_text_only', 'item_title', 'item_citations', 'section_order']
  return typeof value === 'string' && allowed.includes(value as OperationScope) ? value as OperationScope : null
}

function parseExpectedEffect(value: unknown): ExpectedEffect | null {
  const allowed: ExpectedEffect[] = ['preserve_signal', 'increase_argument_density', 'improve_causal_link', 'clarify_objection', 'improve_evidence_binding']
  return typeof value === 'string' && allowed.includes(value as ExpectedEffect) ? value as ExpectedEffect : null
}

function parseResolvedChangeSet(rawOutput: string): { ok: true; value: ResolvedChangeSet } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(rawOutput) as Partial<ResolvedChangeSet>
    const status = parsed.status === 'ok' || parsed.status === 'no_safe_changes' ? parsed.status : null
    if (!status) {
      return { ok: false, error: 'El resolve agent no devolvió un status válido.' }
    }

    const changes = Array.isArray(parsed.changes)
      ? parsed.changes
        .map((item) => {
          const changeType = parseResolvedChangeType(item?.changeType)
          const operationScope = parseOperationScope(item?.operationScope)
          const expectedEffect = parseExpectedEffect(item?.expectedEffect)
          if (
            !item
            || typeof item.changeId !== 'string'
            || typeof item.targetSection !== 'string'
            || !changeType
            || !operationScope
            || !expectedEffect
            || typeof item.instruction !== 'string'
            || !Array.isArray(item.citationsUsed)
            || !Array.isArray(item.evidenceQuoteIds)
            || !Array.isArray(item.protectedSignals)
            || !Array.isArray(item.targetLostSignals)
            || typeof item.minimumRewriteRequirement !== 'string'
            || typeof item.unsafeIfUnsupported !== 'boolean'
          ) {
            return null
          }

          const normalized: ResolvedChange = {
            changeId: item.changeId,
            targetSection: item.targetSection,
            changeType,
            operationScope,
            instruction: item.instruction,
            expectedEffect,
            citationsUsed: item.citationsUsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
            evidenceQuoteIds: item.evidenceQuoteIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
            protectedSignals: normalizeProtectedSignals(item.protectedSignals),
            targetLostSignals: normalizeProtectedSignals(item.targetLostSignals),
            minimumRewriteRequirement: item.minimumRewriteRequirement,
            unsafeIfUnsupported: item.unsafeIfUnsupported,
          }

          return normalized
        })
        .filter((item): item is ResolvedChange => item !== null)
      : []

    return {
      ok: true,
      value: {
        status,
        changes,
      },
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'No se pudo parsear el change set resuelto.',
    }
  }
}

function exampleEvidenceIsExplicit(text: string): boolean {
  return /\bejemplo\b|\bpor ejemplo\b|\banalog[ií]a\b|\bcomo si\b/i.test(text)
}

function hasSignalInText(
  signal: RestoreSignal,
  text: string,
): boolean {
  switch (signal) {
    case 'contrast':
      return /\bsin embargo|en cambio|aunque|pero\b|mientras que|ahora bien|a pesar de|no obstante|por el contrario/i.test(text)
    case 'objection':
      return /\bobjeci[oó]n|cr[ií]tica|pregunta|te dir[aá]n|podr[ií]a decirse/i.test(text)
    case 'response':
      return /\brespuesta|responde|contestaci[oó]n|se aclara|se responde/i.test(text)
    case 'example':
      return /\bejemplo|por ejemplo|analog[ií]a|imagina|igual que|viene a ser/i.test(text)
    default:
      return false
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)))
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'item'
}

function overlapsHeading(targetHeading: string, candidateHeading: string): boolean {
  const a = slugify(targetHeading).split('-').filter(Boolean)
  const b = slugify(candidateHeading).split('-').filter(Boolean)
  return a.length > 0 && b.length > 0 && a.some((token) => b.includes(token))
}

function isArgumentExpansionNeeded(text: string): boolean {
  return /\bpor qu[eé] importa\b|\bcausal\b|\bconsecuencia\b|\bimplica\b|\bjustifica\b|\bdensidad argumental\b|\bfundamento\b|\brelaci[oó]n entre\b|\bcausa.efecto\b|\bpor eso\b|\bpor qu[eé]\b|\bexplicar\b|\bexplicitar\b|\bdesarrollar\b|\bprofundizar\b|\bv[ií]nculo\b|\bcontexto\b|\bhistóric|\bantecedente\b|\bexplica\b|\bjustifica\b|\baclara\b/i.test(text)
}

function classifyExpansionChangeType(text: string): Extract<ResolvedChangeType, 'expand_why_it_matters' | 'expand_causal_link' | 'expand_consequence' | 'expand_evidence_binding' | 'increase_argument_density'> {
  if (/\bpor qu[eé] importa\b|\bpor qu[eé] esto importa\b|\bimporta porque\b/i.test(text)) {
    return 'expand_why_it_matters'
  }
  if (/\bcausal\b|\bpor eso\b|\bporque\b|\bde modo que\b|\bpor lo tanto\b/i.test(text)) {
    return 'expand_causal_link'
  }
  if (/\bconsecuencia\b|\bimplica\b|\bresultado\b|\befecto\b/i.test(text)) {
    return 'expand_consequence'
  }
  if (/\bevidencia\b|\bcita\b|\bjustifica\b|\bfundamento\b|\brespalda\b/i.test(text)) {
    return 'expand_evidence_binding'
  }
  return 'increase_argument_density'
}

function classifyExpansionEffect(changeType: ResolvedChangeType): ExpectedEffect {
  switch (changeType) {
    case 'expand_causal_link':
      return 'improve_causal_link'
    case 'expand_evidence_binding':
      return 'improve_evidence_binding'
    default:
      return 'increase_argument_density'
  }
}

function rankExpansionChangeType(changeType: ResolvedChangeType): number {
  switch (changeType) {
    case 'expand_evidence_binding':
      return 1
    case 'expand_causal_link':
      return 2
    case 'expand_why_it_matters':
      return 3
    case 'expand_consequence':
      return 4
    case 'increase_argument_density':
      return 5
    default:
      return 99
  }
}

function enforceResolvedChangePolicy(changes: ResolvedChange[]): {
  finalChanges: ResolvedChange[]
  rawResolvedChangeCount: number
  finalResolvedChangeCount: number
  policyDroppedChangeIds: string[]
  policyDroppedReasons: Array<{
    changeId: string
    reason:
      | 'max_expansions_per_window'
      | 'max_expansions_per_item'
      | 'lower_priority_expansion'
  }>
} {
  const restoreChanges = changes.filter((change) => !EXPANSION_CHANGE_TYPES.has(change.changeType))
  const expansionChanges = changes
    .filter((change) => EXPANSION_CHANGE_TYPES.has(change.changeType))
    .sort((left, right) => {
      const rankDiff = rankExpansionChangeType(left.changeType) - rankExpansionChangeType(right.changeType)
      if (rankDiff !== 0) {
        return rankDiff
      }
      return left.targetSection.localeCompare(right.targetSection)
    })

  const selectedExpansions: ResolvedChange[] = []
  const expansionCountByItem = new Map<string, number>()
  const policyDroppedReasons: Array<{
    changeId: string
    reason:
      | 'max_expansions_per_window'
      | 'max_expansions_per_item'
      | 'lower_priority_expansion'
  }> = []

  for (const change of expansionChanges) {
    const itemKey = change.targetSection
    const itemCount = expansionCountByItem.get(itemKey) ?? 0

    if (itemCount >= MAX_EXPANSION_CHANGES_PER_ITEM) {
      policyDroppedReasons.push({
        changeId: change.changeId,
        reason: 'max_expansions_per_item',
      })
      continue
    }

    if (selectedExpansions.length >= MAX_EXPANSION_CHANGES_PER_WINDOW) {
      policyDroppedReasons.push({
        changeId: change.changeId,
        reason: 'max_expansions_per_window',
      })
      continue
    }

    selectedExpansions.push(change)
    expansionCountByItem.set(itemKey, itemCount + 1)
  }

  const finalChanges = [...restoreChanges, ...selectedExpansions]
  return {
    finalChanges,
    rawResolvedChangeCount: changes.length,
    finalResolvedChangeCount: finalChanges.length,
    policyDroppedChangeIds: policyDroppedReasons.map((item) => item.changeId),
    policyDroppedReasons,
  }
}

function mentionsSignal(
  signal: RestoreSignal,
  critique: SemanticCritique,
): boolean {
  const combined = [
    ...critique.missingReasoning,
    ...critique.rewritePriorities,
    ...critique.weakBlocks.flatMap((block) => [block.issue, block.fix, block.heading]),
  ].join(' ')

  return hasSignalInText(signal, combined)
}

function planMarksSignalAsMissing(
  signal: RestoreSignal,
  plan: ReasoningPlan,
): boolean {
  return plan.items.some((item) => item.missingRequiredSignals?.includes(signal))
}

function buildRestoreExistingSignalChanges(
  input: ReasoningResolveAgentInput,
  allowedCitationIds: string[],
): ResolvedChange[] {
  const allowed = new Set(allowedCitationIds)
  const critiqueHeadings = input.critique.weakBlocks.map((block) => block.heading.toLowerCase())
  const evidenceHints = input.evidenceHints ?? buildEvidenceDerivedPromptHints({
    currentExtraction: input.originalExtraction,
    minimalEvidence: input.minimalEvidence,
    plan: input.plan,
    critique: input.critique,
  })
  const signals: RestoreSignal[] = ['contrast', 'example', 'objection', 'response']

  const hasCandidateSignalHint = (signal: RestoreSignal): boolean => {
    switch (signal) {
      case 'contrast':
        return evidenceHints.candidateContrasts.length > 0
      case 'objection':
        return evidenceHints.candidateObjections.length > 0 || evidenceHints.candidateContrasts.length > 0
      case 'response':
        return evidenceHints.candidateObjections.length > 0 || evidenceHints.candidateConsequences.length > 0
      case 'example':
        return evidenceHints.candidateExamples.length > 0
      default:
        return false
    }
  }

  const changes = signals.flatMap((signal) => {
    const evidenceQuotes = input.minimalEvidence.filter((quote) => hasSignalInText(signal, quote.text))
    const evidenceHasSignal = evidenceQuotes.length > 0
    const planOrCritiqueRequestsSignal = mentionsSignal(signal, input.critique) || planMarksSignalAsMissing(signal, input.plan)
    const shouldAttemptRestore = (
      planOrCritiqueRequestsSignal
      && evidenceHasSignal
      && hasCandidateSignalHint(signal)
    )

    if (!shouldAttemptRestore) {
      return []
    }

    const targetBlock = input.originalExtraction.noteBlocks.find((block) =>
      critiqueHeadings.some((heading) => heading === block.heading.toLowerCase())
      && (hasSignalInText(signal, `${block.heading} ${block.content}`) || evidenceHasSignal),
    ) ?? input.originalExtraction.noteBlocks.find((block) =>
      hasSignalInText(signal, `${block.heading} ${block.content}`),
    ) ?? input.originalExtraction.noteBlocks[0]

    if (!targetBlock) {
      return []
    }

    const citationsUsed = uniqueStrings([
      ...targetBlock.citations.filter((citation) => allowed.size === 0 || allowed.has(citation)),
      ...evidenceQuotes
        .map((quote) => quote.citationId)
        .filter((citation) => allowed.size === 0 || allowed.has(citation)),
    ]).slice(0, 3)
    const evidenceQuoteIds = uniqueStrings(
      evidenceQuotes.map((quote) => quote.evidenceQuoteId),
    ).slice(0, 3)

    if (citationsUsed.length === 0 || evidenceQuoteIds.length === 0) {
      return []
    }

    const expectedEffect = signal === 'response'
      ? 'improve_causal_link'
      : signal === 'objection'
        ? 'clarify_objection'
        : 'preserve_signal'

    const minimumRewriteRequirement = signal === 'objection'
      ? 'La versión reescrita debe incluir una objeción restaurada con estas 4 partes: 1) marcador de límite o desacuerdo, 2) la afirmación principal que se matiza, 3) una razón concreta del límite o contraargumento, y 4) respaldo en la evidencia o cita asociada.'
      : signal === 'contrast'
        ? 'La versión reescrita debe mostrar una oposición clara entre dos ideas, enfoques o consecuencias, no solo insertar un conector como “pero” o “sin embargo”.'
        : signal === 'example'
          ? 'La versión reescrita debe conservar un caso concreto, instancia o analogía ya presente en la evidencia; no puede inventar un ejemplo nuevo.'
          : 'La versión reescrita debe responder explícitamente a la objeción o problema planteado, manteniendo el mismo significado y sin introducir contenido nuevo.'

    return [{
      changeId: `restore-${signal}-${slugify(targetBlock.heading)}`,
      targetSection: targetBlock.heading,
      changeType: 'restore_existing_signal',
      operationScope: 'item_text_only',
      instruction: `Restaurar de forma low-risk la señal de ${signal} ya presente en current_extraction o evidence, sin agregar ideas nuevas ni cambiar la tesis del item.`,
      expectedEffect,
      citationsUsed,
      evidenceQuoteIds,
      protectedSignals: [signal],
      targetLostSignals: [signal],
      minimumRewriteRequirement,
      unsafeIfUnsupported: true,
    } satisfies ResolvedChange]
  })

  return changes.slice(0, MAX_RESTORE_CHANGES_PER_WINDOW)
}

function buildGroundedExpansionChanges(
  input: ReasoningResolveAgentInput,
  allowedCitationIds: string[],
): ResolvedChange[] {
  const allowed = new Set(allowedCitationIds)
  const priorityText = [...input.critique.rewritePriorities, ...input.critique.missingReasoning]
  const evidenceByCitation = new Map(input.minimalEvidence.map((quote) => [quote.citationId, quote]))
  const rawCandidates = input.critique.weakBlocks.flatMap((block, index) => {
    const combinedReason = `${block.issue} ${block.fix} ${priorityText.join(' ')}`
    if (!isArgumentExpansionNeeded(combinedReason)) {
      return []
    }

    const targetBlock = input.originalExtraction.noteBlocks.find((item) =>
      overlapsHeading(item.heading, block.heading),
    )
    if (!targetBlock) {
      return []
    }

    const allowedBlockCitations = targetBlock.citations.filter((citation) => allowed.size === 0 || allowed.has(citation))
    const evidenceQuotes = allowedBlockCitations
      .map((citationId) => evidenceByCitation.get(citationId))
      .filter((quote): quote is MinimalEvidenceQuote => Boolean(quote))
      .slice(0, 3)

    if (allowedBlockCitations.length === 0 || evidenceQuotes.length === 0) {
      return []
    }

    const changeType = classifyExpansionChangeType(combinedReason)
    const protectedSignals = ['contrast', 'objection', 'response', 'example']
      .filter((signal) => hasSignalInText(signal as RestoreSignal, `${targetBlock.heading} ${targetBlock.content}`)) as Array<'contrast' | 'objection' | 'response' | 'example'>

    const minimumRewriteRequirement = changeType === 'expand_why_it_matters'
      ? 'La versión reescrita debe agregar una oración grounded que explique por qué importa la idea principal o qué problema resuelve, apoyándose en la evidencia del item.'
      : changeType === 'expand_causal_link'
        ? 'La versión reescrita debe agregar una relación causal explícita grounded entre la afirmación y su consecuencia o justificación.'
        : changeType === 'expand_consequence'
          ? 'La versión reescrita debe dejar explícita una consecuencia o implicancia grounded ya sugerida por la evidencia.'
          : changeType === 'expand_evidence_binding'
            ? 'La versión reescrita debe unir más claramente la afirmación con la evidencia citada, sin agregar ideas nuevas ni mover el significado.'
            : 'La versión reescrita debe aumentar la densidad argumental con una expansión grounded, no solo rephrasing.'

    return [{
      changeId: `expand-${index + 1}-${slugify(targetBlock.heading)}`,
      targetSection: targetBlock.heading,
      changeType,
      operationScope: 'item_text_only',
      instruction: `${block.fix} Expandí únicamente con contenido grounded por las citas y snippets provistos, sin introducir ejemplos nuevos ni citas nuevas.`,
      expectedEffect: classifyExpansionEffect(changeType),
      citationsUsed: uniqueStrings(allowedBlockCitations).slice(0, 3),
      evidenceQuoteIds: uniqueStrings(evidenceQuotes.map((quote) => quote.evidenceQuoteId)).slice(0, 3),
      protectedSignals,
      targetLostSignals: [],
      minimumRewriteRequirement,
      unsafeIfUnsupported: true,
    } satisfies ResolvedChange]
  })

  const byPriority = rawCandidates.sort((left, right) => {
    const rankDiff = rankExpansionChangeType(left.changeType) - rankExpansionChangeType(right.changeType)
    if (rankDiff !== 0) {
      return rankDiff
    }
    return left.targetSection.localeCompare(right.targetSection)
  })

  const perItemCount = new Map<string, number>()
  const selected: ResolvedChange[] = []
  for (const candidate of byPriority) {
    if (selected.length >= MAX_EXPANSION_CHANGES_PER_WINDOW) {
      break
    }

    const itemCount = perItemCount.get(candidate.targetSection) ?? 0
    if (itemCount >= MAX_EXPANSION_CHANGES_PER_ITEM) {
      continue
    }

    selected.push(candidate)
    perItemCount.set(candidate.targetSection, itemCount + 1)
  }

  return selected
}

function extractionOrEvidenceHasProtectedSignal(
  signal: 'contrast' | 'objection' | 'response' | 'example',
  extractionText: string,
  evidenceText: string,
): boolean {
  switch (signal) {
    case 'contrast':
      return /\bsin embargo|en cambio|aunque|pero\b|mientras que|ahora bien|a pesar de|no obstante|por el contrario/i.test(extractionText) || /\bsin embargo|en cambio|aunque|pero\b|mientras que|ahora bien|a pesar de|no obstante|por el contrario/i.test(evidenceText)
    case 'objection':
      return /\bobjeci[oó]n|cr[ií]tica|pregunta|te dir[aá]n|podr[ií]a decirse/i.test(extractionText) || /\bobjeci[oó]n|cr[ií]tica|pregunta|te dir[aá]n|podr[ií]a decirse/i.test(evidenceText)
    case 'response':
      return /\brespuesta|responde|contestaci[oó]n|se aclara|se responde/i.test(extractionText) || /\brespuesta|responde|contestaci[oó]n|se aclara|se responde/i.test(evidenceText)
    case 'example':
      return /\bejemplo|por ejemplo|analog[ií]a|imagina|igual que|viene a ser/i.test(extractionText) || /\bejemplo|por ejemplo|analog[ií]a|imagina|igual que|viene a ser/i.test(evidenceText)
    default:
      return false
  }
}

function normalizeGroundingText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .toLowerCase()
}

function buildGroundingTokenSet(text: string): Set<string> {
  return new Set(
    normalizeGroundingText(text)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 5),
  )
}

function validateResolvedChangeGrounding(
  change: ResolvedChange,
  extractionContext: string,
  evidenceContextById: Map<string, string>,
  planContext: string,
  critiqueContext: string,
  hints: EvidenceDerivedPromptHints,
): { ok: true } | { ok: false; reason: 'instruction_out_of_evidence' | 'cross_domain_terms_not_supported'; severity: 'warn' | 'reject'; unsupportedTerms: string[] } {
  const allowedMetaTokens = new Set([
    'agregar', 'oracion', 'oraciones', 'explicito', 'explicita', 'explicito', 'cambio', 'cambios',
    'restaurar', 'restaure', 'restaura', 'version', 'reescrita', 'debe', 'mantener', 'dejar', 'claro',
    'evidencia', 'cita', 'citas', 'grounded', 'item', 'texto', 'senal', 'senales', 'contraste', 'objecion',
    'respuesta', 'ejemplo', 'limite', 'contraargumento', 'afirmacion', 'principal', 'tesis', 'expansion',
    'causal', 'consecuencia', 'implicancia', 'fundamento', 'explicar', 'explicando', 'apoyandose', 'apoyarse',
    'persistente', 'actual', 'enfoque', 'metodo', 'pregunta', 'consulta', 'memoria', 'knowledge', 'wiki',
    'conceptos', 'externos', 'externo', 'contenido', 'introducir', 'sugeridos', 'sugerida', 'incluir',
    'razon', 'concreta', 'concreto', 'oposicion', 'forma', 'manera', 'restauracion', 'restaurando',
  ])

  const evidenceContext = change.evidenceQuoteIds
    .map((quoteId) => evidenceContextById.get(quoteId) ?? '')
    .join(' ')
  const hintContext = [
    ...hints.domainVocabulary,
    ...hints.allowedSystemTerms,
    ...hints.candidateClaims,
    ...hints.candidateContrasts.flatMap((item) => [item.left, item.right, item.contrastRelation]),
    ...hints.candidateObjections.flatMap((item) => [item.claim, item.limit, item.reason]),
    ...hints.candidateExamples.flatMap((item) => [item.example, item.illustrates]),
    ...hints.candidateConsequences.flatMap((item) => [item.causeOrInput, item.consequence, item.whyItMatters]),
  ].join(' ')
  const sourceTokens = buildGroundingTokenSet(`${extractionContext} ${evidenceContext} ${planContext} ${critiqueContext} ${hintContext}`)
  const candidateTokens = Array.from(new Set(
    buildGroundingTokenSet(`${change.instruction} ${change.minimumRewriteRequirement}`),
  )).filter((token) => !allowedMetaTokens.has(token))
  const unsupportedTokens = candidateTokens.filter((token) => !sourceTokens.has(token))

  if (unsupportedTokens.length === 0) {
    return { ok: true }
  }

  const severity = unsupportedTokens.length >= 4 ? 'reject' : 'warn'
  return {
    ok: false,
    reason: severity === 'reject' ? 'cross_domain_terms_not_supported' : 'instruction_out_of_evidence',
    severity,
    unsupportedTerms: unsupportedTokens,
  }
}

export async function runReasoningResolveAgent(
  input: ReasoningResolveAgentInput,
  allowedCitationIds: string[],
): Promise<{ ok: true; value: ResolvedChangeSet; rawOutput: string } | { ok: false; error: string; rawOutput?: string }> {
  const evidenceHints = input.evidenceHints ?? buildEvidenceDerivedPromptHints({
    currentExtraction: input.originalExtraction,
    minimalEvidence: input.minimalEvidence,
    plan: input.plan,
    critique: input.critique,
  })
  const system = [
    'Sos el subagente resolve grounded.',
    'Tu única tarea es decidir cambios seguros y explícitos; no redactes la salida final.',
    'Podés devolver no_safe_changes si no hay mejoras seguras.',
    'Respondé únicamente con JSON válido.',
  ].join('\n')

  const prompt = [
    '<title>Resolver cambios seguros</title>',
    '<problem>',
    'Debés resolver plan + critique en una lista de cambios explícitos y seguros para que otro agente los ejecute.',
    '</problem>',
    '<rules>',
    'No redactes la extracción final.',
    'Cada cambio debe ser concreto, localizado y ejecutable sin reinterpretar el plan.',
    'Si un cambio no es seguro, no lo propongas.',
    'Podés devolver status=no_safe_changes y changes=[] si no hay cambios seguros.',
    'add_example solo está permitido si el ejemplo está explícitamente presente en la evidencia mínima.',
    'Si una señal argumental aparece como perdida o débil, primero intentá restaurarla con changeType=restore_existing_signal como cambio low-risk.',
    'No inventes una señal nueva: restore_existing_signal solo puede restaurar una señal que ya esté en current_extraction o en la evidencia.',
    'Para objection: no alcanza con poner “pero” o “sin embargo”; debe aparecer una oración explícita que limite, cuestione o matice la afirmación principal y explique el contraargumento.',
    'Para contrast: debe quedar una oposición clara entre dos ideas, enfoques o consecuencias; un conector suelto no alcanza.',
    'Para example: solo podés conservar o reintroducir un caso concreto, instancia o analogía ya presente en la evidencia; nunca inventes uno.',
    'No uses ejemplos de dominio fijo. Si necesitás ilustrar estructura, usá placeholders abstractos como [afirmación principal], [límite], [evidencia], [consecuencia].',
    'Si necesitás contenido concreto, tomalo únicamente de current_extraction, minimalEvidence, plan, critique o evidence_derived_prompt_hints.',
    'Si la ventana sigue comprimida pero no faltan señales críticas, proponé cambios de expansión grounded con changeType=expand_why_it_matters, expand_causal_link, expand_consequence, expand_evidence_binding o increase_argument_density.',
    'Los cambios de expansión grounded deben estar anclados en evidenceQuoteIds concretos y no pueden introducir citas nuevas ni ejemplos nuevos.',
    'Para objection restaurada, exigí cuatro partes verificables: marcador de límite o desacuerdo, afirmación principal matizada, razón concreta del límite y evidencia/cita asociada.',
    `Máximo ${MAX_EXPANSION_CHANGES_PER_WINDOW} cambios de expansión grounded por ventana en el set final combinado.`,
    `Máximo ${MAX_EXPANSION_CHANGES_PER_ITEM} cambio de expansión grounded por item en el set final combinado.`,
    'Priorizá los cambios de expansión en este orden: expand_evidence_binding, expand_causal_link, expand_why_it_matters, expand_consequence, increase_argument_density.',
    'Usá increase_argument_density solo como último recurso, porque es el tipo más abstracto y más riesgoso.',
    'No propongas cambios si no podés anclarlos en evidenceQuoteIds concretos.',
    'Definí protectedSignals con las señales del item original que NO se pueden perder al reescribir.',
    'Definí targetLostSignals con las señales concretas que este cambio intenta restaurar o fortalecer.',
    'Definí minimumRewriteRequirement como el requisito mínimo verificable que el rewrite debe cumplir para considerar aplicado el cambio.',
    '</rules>',
    '<contract>',
    'Cada change debe incluir: changeId, targetSection, changeType, operationScope, instruction, expectedEffect, citationsUsed, evidenceQuoteIds, protectedSignals, targetLostSignals, minimumRewriteRequirement, unsafeIfUnsupported.',
    'operationScope puede ser: item_text_only, item_title, item_citations, section_order.',
    'Separá mentalmente dos estrategias: restauración fuerte de señales críticas (W1/W2) y expansión argumental grounded (W3/W4).',
    '</contract>',
    '<evidence_derived_prompt_hints>',
    JSON.stringify(evidenceHints, null, 2),
    'Los hints son sugerencias derivadas automáticamente. Si un hint no está respaldado por evidenceQuoteIds o contradice la evidencia, ignoralo.',
    '</evidence_derived_prompt_hints>',
    '<current_extraction>',
    JSON.stringify(input.originalExtraction, null, 2),
    '</current_extraction>',
    '<plan>',
    JSON.stringify(input.plan, null, 2),
    '</plan>',
    '<critique>',
    JSON.stringify(input.critique, null, 2),
    '</critique>',
    '<minimal_evidence>',
    JSON.stringify(input.minimalEvidence, null, 2),
    '</minimal_evidence>',
    '<examples>',
    JSON.stringify({
      status: 'ok',
      changes: [
        {
          changeId: 'chg-1',
          targetSection: '[REEMPLAZAR: heading real del item objetivo]',
          changeType: 'restore_existing_signal',
          operationScope: 'item_text_only',
          instruction: 'Restaurar la señal de [TIPO: contrast|objection] en el item [HEADING-REAL]: agregar la oración específica que expresa [REEMPLAZAR: la oposición o límite ya presente en la evidencia de este job].',
          expectedEffect: 'clarify_objection',
          citationsUsed: ['[C_REAL]'],
          evidenceQuoteIds: ['[Q_REAL]'],
          protectedSignals: ['contrast', 'objection'],
          targetLostSignals: ['objection'],
          minimumRewriteRequirement: 'La versión reescrita debe incluir una oración que limite o cuestione la afirmación principal con una razón concreta y respaldo de la evidencia.',
          unsafeIfUnsupported: true,
        },
      ],
    }, null, 2),
    JSON.stringify({
      status: 'ok',
      changes: [
        {
          changeId: 'exp-1',
          targetSection: '[REEMPLAZAR: heading real del item objetivo]',
          changeType: 'expand_why_it_matters',
          operationScope: 'item_text_only',
          instruction: 'Expandir [HEADING-REAL] con [REEMPLAZAR: la consecuencia o relación causal específica que ya figura en los quotes provistos para este job].',
          expectedEffect: 'increase_argument_density',
          citationsUsed: ['[C_REAL]'],
          evidenceQuoteIds: ['[Q_REAL]'],
          protectedSignals: ['contrast'],
          targetLostSignals: [],
          minimumRewriteRequirement: 'La versión reescrita debe agregar una consecuencia o por-qué-importa ya mencionada en la evidencia citada, sin inventar contenido nuevo.',
          unsafeIfUnsupported: true,
        },
      ],
    }, null, 2),
    JSON.stringify({
      status: 'no_safe_changes',
      changes: [],
    }, null, 2),
    '</examples>',
  ].join('\n')

  const rawOutput = await completeOllamaResponse({
    system,
    prompt,
    maxContinuations: appConfig.maxChainSemanticEnrichmentAttempts,
    responseFormat: buildResolvedChangeSchema(allowedCitationIds, input.minimalEvidence.map((quote) => quote.evidenceQuoteId)),
    profile: {
      numCtx: appConfig.fullNotesOllamaNumCtx,
      numPredict: appConfig.fullNotesOllamaNumPredict,
      keepAlive: appConfig.ollamaKeepAlive,
    },
  })

  const parsed = parseResolvedChangeSet(rawOutput)
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, rawOutput }
  }

  const minimalEvidenceById = new Map(input.minimalEvidence.map((quote) => [quote.evidenceQuoteId, quote]))
  const originalExtractionText = input.originalExtraction.noteBlocks.map((block) => `${block.heading} ${block.content}`).join(' ')
  const planContext = input.plan.items
    .flatMap((item) => [item.title, item.coreClaim, item.whyItMatters, ...item.supportingPoints])
    .join(' ')
  const critiqueContext = [
    ...input.critique.missingReasoning,
    ...input.critique.rewritePriorities,
    ...input.critique.weakBlocks.flatMap((block) => [block.heading, block.issue, block.fix]),
  ].join(' ')
  const evidenceContextById = new Map(input.minimalEvidence.map((quote) => [quote.evidenceQuoteId, quote.text]))
  const groundingRejectedReasons: Array<{ changeId: string; reason: 'instruction_out_of_evidence' | 'cross_domain_terms_not_supported'; severity?: 'warn' | 'reject'; unsupportedTerms?: string[] }> = []
  const validatedChanges = parsed.value.changes.filter((change) => {
    if (change.evidenceQuoteIds.length === 0) {
      return false
    }
    const evidenceQuotes = change.evidenceQuoteIds
      .map((quoteId) => minimalEvidenceById.get(quoteId))
      .filter((quote): quote is MinimalEvidenceQuote => Boolean(quote))

    if (evidenceQuotes.length !== change.evidenceQuoteIds.length) {
      return false
    }

    if (change.changeType === 'add_example' && !evidenceQuotes.some((quote) => exampleEvidenceIsExplicit(quote.text))) {
      return false
    }

    if (
      change.changeType === 'restore_existing_signal'
      && !change.protectedSignals.some((signal) =>
        extractionOrEvidenceHasProtectedSignal(
          signal,
          originalExtractionText,
          evidenceQuotes.map((quote) => quote.text).join(' '),
        ),
      )
    ) {
      return false
    }

    const groundingValidation = validateResolvedChangeGrounding(
      change,
      originalExtractionText,
      evidenceContextById,
      planContext,
      critiqueContext,
      evidenceHints,
    )
    if (!groundingValidation.ok) {
      groundingRejectedReasons.push({
        changeId: change.changeId,
        reason: groundingValidation.reason,
        severity: groundingValidation.severity,
        unsupportedTerms: groundingValidation.unsupportedTerms,
      })
      return groundingValidation.severity !== 'reject'
    }

    return true
  })

  const restoredFallbackChanges = validatedChanges.length === 0
    ? buildRestoreExistingSignalChanges(input, allowedCitationIds)
    : []
  const deterministicExpansionChanges = buildGroundedExpansionChanges(input, allowedCitationIds)
  const mergedChanges = uniqueStrings([
    ...validatedChanges.map((change) => change.changeId),
    ...restoredFallbackChanges.map((change) => change.changeId),
    ...deterministicExpansionChanges.map((change) => change.changeId),
  ]).map((changeId) =>
    [...validatedChanges, ...restoredFallbackChanges, ...deterministicExpansionChanges].find((change) => change.changeId === changeId),
  ).filter((change): change is ResolvedChange => Boolean(change))
  const policyResult = enforceResolvedChangePolicy(mergedChanges)
  const finalChanges = policyResult.finalChanges

  const value: ResolvedChangeSet = {
    status: finalChanges.length === 0 ? 'no_safe_changes' : 'ok',
    changes: finalChanges,
    rawResolvedChangeCount: policyResult.rawResolvedChangeCount,
    finalResolvedChangeCount: policyResult.finalResolvedChangeCount,
    groundingRejectedChangeIds: groundingRejectedReasons.map((item) => item.changeId),
    groundingRejectedReasons,
    policyDroppedChangeIds: policyResult.policyDroppedChangeIds,
    policyDroppedReasons: policyResult.policyDroppedReasons,
  }

  return { ok: true, value, rawOutput }
}
