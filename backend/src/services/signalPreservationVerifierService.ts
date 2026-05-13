import type {
  ControlledAppliedChange,
  ControlledAppliedChangeMarker,
  MinimalEvidenceQuote,
  SignalPreservationVerifierInput,
  SignalPreservationVerifierResult,
} from './experimentalRewriteTypes.js'

type ProtectedSignal = 'contrast' | 'objection' | 'response' | 'example'

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .toLowerCase()
}

function overlapsLoosely(a: string, b: string): boolean {
  const left = new Set(normalize(a).split(/[^a-z0-9]+/).filter((token) => token.length >= 4))
  const right = new Set(normalize(b).split(/[^a-z0-9]+/).filter((token) => token.length >= 4))
  let matches = 0

  for (const token of left) {
    if (right.has(token)) {
      matches += 1
    }
  }

  return matches >= 1
}

function hasSignal(text: string, signal: ProtectedSignal): boolean {
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

function hasStrictObjection(text: string): boolean {
  const normalized = normalize(text)
  const limitPattern = /\bpero\b|\bsin embargo\b|\baunque\b|\bno obstante\b|\blimite\b|\bproblema\b|\bobjecion\b/
  if (!limitPattern.test(normalized)) return false
  const sentences = normalized.split(/[.;!?]+/).filter(s => s.trim().length > 0)
  return sentences.some(sentence => {
    if (!limitPattern.test(sentence)) return false
    const contentWords = sentence.trim().split(/\s+/).filter(w => w.length >= 3).length
    return contentWords >= 6
  })
}

function hasStrictContrast(text: string): boolean {
  const normalized = normalize(text)
  const contrastPattern = /\bsin embargo\b|\ben cambio\b|\bmientras que\b|\baunque\b|\bpor otro lado\b|\ba diferencia\b|\bpor el contrario\b/
  if (!contrastPattern.test(normalized)) return false
  const sentences = normalized.split(/[.;!?]+/).filter(s => s.trim().length > 0)
  return sentences.some(sentence => {
    if (!contrastPattern.test(sentence)) return false
    const contentWords = sentence.trim().split(/\s+/).filter(w => w.length >= 3).length
    return contentWords >= 8
  })
}

function hasStrictExample(text: string, evidenceContext: string): boolean {
  return hasSignal(text, 'example') && hasSignal(evidenceContext, 'example')
}

function detectSignalsInText(text: string): ProtectedSignal[] {
  return (['contrast', 'objection', 'response', 'example'] as ProtectedSignal[]).filter((signal) => hasSignal(text, signal))
}

function hasGroundingSupport(
  value: string,
  extractionContext: string,
  evidenceContext: string,
  maxUnsupported = 1,
): boolean {
  const sourceTokens = new Set(
    normalize(`${extractionContext} ${evidenceContext}`)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 5),
  )
  const allowedMetaTokens = new Set([
    'agregar', 'oracion', 'oraciones', 'explicito', 'explicita', 'explicitar', 'cambio', 'cambios',
    'tesis', 'evidencia', 'citas', 'cita', 'grounded', 'signal', 'signals', 'objecion', 'contraste',
    'respuesta', 'ejemplo', 'limite', 'contraargumento', 'principal', 'afirmacion', 'consecuencia',
    'implicancia', 'version', 'reescrita', 'debe', 'mantener', 'restaurar', 'seccion', 'item',
    'incluir', 'razon', 'concreta', 'concreto', 'sugeridos', 'sugerida', 'introducir',
    'conceptos', 'externos', 'externo', 'contenido', 'oposicion', 'forma', 'manera',
  ])

  const candidateTokens = Array.from(new Set(
    normalize(value)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 5 && !allowedMetaTokens.has(token)),
  ))

  const unsupported = candidateTokens.filter((token) => !sourceTokens.has(token))
  return unsupported.length <= maxUnsupported
}

function evaluateMinimumRequirement(
  change: SignalPreservationVerifierInput['resolvedChanges']['changes'][number],
  rewrittenText: string,
  evidenceContext: string,
): { ok: boolean; ineffectiveReason?: ControlledAppliedChange['ineffectiveReason'] } {
  if (!hasGroundingSupport(change.instruction, rewrittenText, evidenceContext)
    || !hasGroundingSupport(change.minimumRewriteRequirement, rewrittenText, evidenceContext, 2)) {
    return { ok: false, ineffectiveReason: 'unsupported_by_evidence' }
  }

  if (change.changeType === 'restore_existing_signal') {
    const primaryTarget = change.targetLostSignals[0]
    if (primaryTarget === 'contrast') {
      return hasStrictContrast(rewrittenText)
        ? { ok: true }
        : { ok: false, ineffectiveReason: 'minimum_requirement_not_met' }
    }
    if (primaryTarget === 'example') {
      return hasStrictExample(rewrittenText, evidenceContext)
        ? { ok: true }
        : { ok: false, ineffectiveReason: 'minimum_requirement_not_met' }
    }
    return hasStrictObjection(rewrittenText)
      ? { ok: true }
      : { ok: false, ineffectiveReason: 'minimum_requirement_not_met' }
  }

  if (change.changeType === 'add_objection') {
    return hasStrictObjection(rewrittenText)
      ? { ok: true }
      : { ok: false, ineffectiveReason: 'minimum_requirement_not_met' }
  }

  if (change.changeType === 'add_contrast') {
    return hasStrictContrast(rewrittenText)
      ? { ok: true }
      : { ok: false, ineffectiveReason: 'minimum_requirement_not_met' }
  }

  if (change.changeType === 'add_example') {
    return hasStrictExample(rewrittenText, evidenceContext)
      ? { ok: true }
      : { ok: false, ineffectiveReason: 'minimum_requirement_not_met' }
  }

  return { ok: true }
}

function findSectionText(targetSection: string, sections: Array<{ heading: string; content: string }>): string {
  const exact = sections.find((section) => section.heading.trim().toLowerCase() === targetSection.trim().toLowerCase())
  if (exact) {
    return exact.content
  }

  const loose = sections.find((section) => overlapsLoosely(section.heading, targetSection))
  return loose?.content ?? ''
}

function buildEvidenceContext(quotes: MinimalEvidenceQuote[]): string {
  return quotes.map((quote) => quote.text).join(' ')
}

function detectRestoredSignals(
  originalText: string,
  rewrittenText: string,
  evidenceContext: string,
  targetSignals: ProtectedSignal[],
): ProtectedSignal[] {
  return targetSignals.filter((signal) => {
    const existedBefore = hasSignal(originalText, signal) || hasSignal(evidenceContext, signal)
    const existsAfter = hasSignal(rewrittenText, signal)
    return existedBefore && existsAfter
  })
}

export function verifySignalPreservation(
  input: SignalPreservationVerifierInput,
): SignalPreservationVerifierResult {
  const originalSections = input.originalExtraction.noteBlocks.map((block) => ({
    heading: block.heading,
    content: block.content,
  }))
  const rewrittenSections = input.rewrittenExtraction.noteBlocks.map((block) => ({
    heading: block.heading,
    content: block.content,
  }))
  const originalCombined = originalSections.map((section) => section.content).join(' ')
  const rewrittenCombined = rewrittenSections.map((section) => section.content).join(' ')
  const evidenceContext = buildEvidenceContext(input.minimalEvidence)

  const lostSignals = new Set<ProtectedSignal>()
  const unsafeAppliedChanges = new Set<string>()
  const appliedChangeOutcomes: ControlledAppliedChange[] = []
  const appliedMarkers = new Set(input.appliedChanges.map((change) => change.changeId))

  for (const change of input.resolvedChanges.changes) {
    if (!appliedMarkers.has(change.changeId)) {
      continue
    }

    const originalSectionText = findSectionText(change.targetSection, originalSections)
    const rewrittenSectionText = findSectionText(change.targetSection, rewrittenSections)
    const referenceOriginal = originalSectionText || originalCombined
    const referenceRewritten = rewrittenSectionText || rewrittenCombined
    const restoredSignals = detectRestoredSignals(
      referenceOriginal,
      referenceRewritten || rewrittenCombined,
      evidenceContext,
      change.targetLostSignals.length > 0 ? change.targetLostSignals : change.protectedSignals,
    )
    const derivedSignals = detectSignalsInText(referenceRewritten || rewrittenCombined)
    const minimumRequirement = evaluateMinimumRequirement(change, referenceRewritten || rewrittenCombined, evidenceContext)

    for (const signal of change.protectedSignals) {
      const shouldProtect = hasSignal(referenceOriginal, signal) || hasSignal(evidenceContext, signal)
      if (!shouldProtect) {
        continue
      }

      if (!hasSignal(referenceRewritten, signal) && !hasSignal(rewrittenCombined, signal)) {
        lostSignals.add(signal)
        unsafeAppliedChanges.add(change.changeId)
      }
    }

    appliedChangeOutcomes.push({
      changeId: change.changeId,
      applied: true,
      minimumRequirementSatisfied: minimumRequirement.ok && (change.targetLostSignals.length > 0
        ? restoredSignals.some((signal) => change.targetLostSignals.includes(signal))
        : (derivedSignals.length > 0 || change.protectedSignals.length === 0)),
      restoredSignals,
      ineffectiveReason: minimumRequirement.ok
        ? (
        change.targetLostSignals.length > 0
        && !restoredSignals.some((signal) => change.targetLostSignals.includes(signal))
      )
        ? 'target_signal_not_restored'
        : (
            derivedSignals.length === 0
            && change.protectedSignals.length > 0
          )
            ? 'too_weak'
            : undefined
        : minimumRequirement.ineffectiveReason,
    })
  }

  const explicitProtectedLosses = input.protectedSignals.filter((signal) =>
    (hasSignal(originalCombined, signal) || hasSignal(evidenceContext, signal))
    && !hasSignal(rewrittenCombined, signal),
  )

  for (const signal of explicitProtectedLosses) {
    lostSignals.add(signal)
  }

  const lostSignalsList = Array.from(lostSignals)
  const unsafeChangesList = Array.from(unsafeAppliedChanges)

  return {
    signalIntegrityOk: lostSignalsList.length === 0 && unsafeChangesList.length === 0,
    lostSignals: lostSignalsList,
    unsafeAppliedChanges: unsafeChangesList,
    appliedChangeOutcomes: appliedChangeOutcomes.map((outcome) =>
      unsafeAppliedChanges.has(outcome.changeId)
        ? {
            ...outcome,
            minimumRequirementSatisfied: false,
            restoredSignals: [],
            ineffectiveReason: 'changed_meaning',
          }
        : outcome,
    ),
    reason: lostSignalsList.length === 0
      ? 'Las señales protegidas se preservaron en la rewrite experimental.'
      : `Se perdieron señales protegidas: ${lostSignalsList.join(', ')}.`,
  }
}
