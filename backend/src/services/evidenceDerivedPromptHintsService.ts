import type { GroundedWindowExtraction } from './groundingTypes.js'
import type { MinimalEvidenceQuote } from './experimentalRewriteTypes.js'
import type { ReasoningPlan } from './reasoningPlanAgentService.js'
import type { SemanticCritique } from './semanticCritiqueService.js'

export interface CandidateContrast {
  left: string
  right: string
  contrastRelation: string
  evidenceQuoteIds: string[]
}

export interface CandidateObjection {
  claim: string
  limit: string
  reason: string
  evidenceQuoteIds: string[]
}

export interface CandidateExample {
  example: string
  illustrates: string
  evidenceQuoteIds: string[]
}

export interface CandidateConsequence {
  causeOrInput: string
  consequence: string
  whyItMatters: string
  evidenceQuoteIds: string[]
}

export interface EvidenceDerivedPromptHints {
  domainVocabulary: string[]
  allowedSystemTerms: string[]
  candidateClaims: string[]
  candidateContrasts: CandidateContrast[]
  candidateObjections: CandidateObjection[]
  candidateExamples: CandidateExample[]
  candidateConsequences: CandidateConsequence[]
}

const STOPWORDS = new Set([
  'para', 'como', 'esta', 'este', 'estos', 'estas', 'desde', 'entre', 'sobre', 'porque', 'donde',
  'cuando', 'cada', 'solo', 'tambien', 'puede', 'pueden', 'haber', 'hacia', 'luego', 'mismo', 'misma',
  'mismos', 'mismas', 'tener', 'tiene', 'tienen', 'hacer', 'hacen', 'usar', 'usan', 'using', 'with',
  'that', 'this', 'your', 'their', 'from', 'into', 'then', 'than', 'there', 'here', 'cual', 'cuales',
  'diferencia', 'importa', 'explica', 'explicar', 'afirma', 'afirmacion', 'principal', 'sobre', 'tras',
])

const ALLOWED_SYSTEM_TERMS = [
  'claim',
  'objecion',
  'contraste',
  'evidencia',
  'consecuencia',
  'causalidad',
  'sintesis',
  'limite',
  'respuesta',
  'ejemplo',
  'afirmacion',
  'contraargumento',
  'sugerido',
  'sugeridos',
  'introducir',
  'externo',
  'externos',
  'razon',
  'concreta',
  'concreto',
  'explicito',
  'restaurar',
  'reescrita',
  'version',
  'senal',
  'senales',
  'importa',
  'importancia',
  'citada',
  'citado',
  'cita',
  'citas',
  'incluir',
  'incluye',
  'incluido',
  'asociada',
  'asociado',
  'respaldado',
  'respaldada',
  'importar',
  'citado',
  'citados',
  'incluyendo',
  'asociar',
  'asociada',
  'asociado',
  'apoyado',
  'apoyada',
]

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .toLowerCase()
}

function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values))
}

function scoreTerms(chunks: Array<{ text: string; weight: number }>): string[] {
  const scores = new Map<string, number>()

  for (const chunk of chunks) {
    for (const token of tokenize(chunk.text)) {
      scores.set(token, (scores.get(token) ?? 0) + chunk.weight)
    }
  }

  return Array.from(scores.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 24)
    .map(([token]) => token)
}

function extractSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function pickCandidates(values: string[], limit = 5): string[] {
  return unique(values.map((item) => item.trim()).filter(Boolean)).slice(0, limit)
}

function hasMarker(text: string, regex: RegExp): boolean {
  return regex.test(normalize(text))
}

function isLimitationText(text: string): boolean {
  return hasMarker(text, /\bdesde cero\b|\bsin memoria\b|\bno hay memoria\b|\bno acumul|\brepite\b|\bfragmentos\b|\baislad|\blimite\b|\bproblema\b|\bfalta\b|\bcarencia\b/)
}

function isAlternativeText(text: string): boolean {
  return hasMarker(text, /\bsolucion\b|\bpropone\b|\bpermite\b|\bbase\b|\bpersist|\bwiki\b|\bintegra\b|\bacumul|\bconecta\b|\bsistema\b|\buna vez\b/)
}

function isConsequenceText(text: string): boolean {
  return hasMarker(text, /\binefici|\bfrustr|\blimita\b|\bimplica\b|\bresultado\b|\bconsecuencia\b|\bpor eso\b|\bpor lo tanto\b|\bentonces\b|\belimina\b|\breduce\b/)
}

function firstSentenceMatching(text: string, regex: RegExp): string | null {
  return extractSentences(text).find((sentence) => regex.test(normalize(sentence))) ?? null
}

function compact(text: string, maxLength = 220): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1).trimEnd()}…`
}

function buildClaimPool({
  currentExtraction,
  plan,
}: {
  currentExtraction: GroundedWindowExtraction
  plan?: ReasoningPlan
}): string[] {
  return pickCandidates([
    ...(plan?.items.map((item) => item.coreClaim) ?? []),
    ...currentExtraction.noteBlocks.flatMap((block) => extractSentences(block.content).slice(0, 1)),
  ], 8)
}

function buildCandidateContrasts({
  plan,
  minimalEvidence,
}: {
  plan?: ReasoningPlan
  minimalEvidence: MinimalEvidenceQuote[]
}): CandidateContrast[] {
  const candidates: CandidateContrast[] = []

  for (const item of plan?.items ?? []) {
    if (!item.requiredSignals.includes('contrast')) {
      continue
    }

    const planTexts = [item.coreClaim, ...item.supportingPoints, item.whyItMatters]
    const left = planTexts.find((point) => isLimitationText(point)) ?? item.coreClaim
    const right = planTexts.find((point) => isAlternativeText(point) && !isConsequenceText(point)) ?? item.whyItMatters

    if (
      normalize(left) !== normalize(right)
      && isLimitationText(left)
      && (isAlternativeText(right) || isAlternativeText(item.whyItMatters))
    ) {
      candidates.push({
        left: compact(left),
        right: compact(right),
        contrastRelation: 'limitacion o enfoque actual frente a alternativa o enfoque persistente presente en la evidencia',
        evidenceQuoteIds: item.citations.slice(0, 2).map((_, index) => `Q${index + 1}`),
      })
    }
  }

  const limitationQuotes = minimalEvidence.filter((quote) =>
    isLimitationText(quote.text),
  )
  const alternativeQuotes = minimalEvidence.filter((quote) =>
    isAlternativeText(quote.text) && !isConsequenceText(quote.text),
  )

  for (const leftQuote of limitationQuotes.slice(0, 2)) {
    const rightQuote = alternativeQuotes.find((quote) => quote.evidenceQuoteId !== leftQuote.evidenceQuoteId)
    if (!rightQuote) {
      continue
    }

    candidates.push({
      left: compact(firstSentenceMatching(leftQuote.text, /\bdesde cero\b|\bsin memoria\b|\bno acumul|\brepite\b|\blimite\b|\bproblema\b/) ?? leftQuote.text),
      right: compact(firstSentenceMatching(rightQuote.text, /\bsolucion\b|\bpropone\b|\bpermite\b|\bpersist|\bwiki\b|\bintegra\b|\bacumul|\bconecta\b|\buna vez\b/) ?? rightQuote.text),
      contrastRelation: 'consulta aislada o reconstruccion repetida frente a integracion o acumulacion persistente',
      evidenceQuoteIds: [leftQuote.evidenceQuoteId, rightQuote.evidenceQuoteId],
    })
  }

  return unique(candidates.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item)).slice(0, 5)
}

function buildCandidateObjections({
  claimPool,
  minimalEvidence,
}: {
  claimPool: string[]
  minimalEvidence: MinimalEvidenceQuote[]
}): CandidateObjection[] {
  const candidates: CandidateObjection[] = []

  for (const quote of minimalEvidence) {
    const normalized = normalize(quote.text)
    if (!/\blimite\b|\bproblema\b|\bobjecion\b|\bcritica\b|\bdesde cero\b|\bsin memoria\b|\bno hay memoria\b|\bno acumul/.test(normalized)) {
      continue
    }

    const claim = claimPool[0] ?? compact(extractSentences(quote.text)[0] ?? quote.text)
    const limitSentence = extractSentences(quote.text).find((sentence) =>
      /\bpero\b|\bsin embargo\b|\blimite\b|\bproblema\b|\bno\b|\bfalta\b/i.test(sentence),
    ) ?? extractSentences(quote.text)[0] ?? quote.text
    const reasonSentence = extractSentences(quote.text).find((sentence) =>
      /\bporque\b|\bya que\b|\bdesde cero\b|\bsin memoria\b|\bno acumul|\brepite\b/i.test(sentence),
    ) ?? limitSentence

    candidates.push({
      claim: compact(claim),
      limit: compact(limitSentence),
      reason: compact(reasonSentence),
      evidenceQuoteIds: [quote.evidenceQuoteId],
    })
  }

  return unique(candidates.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item)).slice(0, 5)
}

function buildCandidateExamples({
  claimPool,
  minimalEvidence,
}: {
  claimPool: string[]
  minimalEvidence: MinimalEvidenceQuote[]
}): CandidateExample[] {
  const candidates: CandidateExample[] = []

  for (const quote of minimalEvidence) {
    if (!hasMarker(quote.text, /\bejemplo\b|\bpor ejemplo\b|\banalogia\b|\bimagina\b|\bcomo si\b/)) {
      continue
    }

    const exampleSentence = extractSentences(quote.text).find((sentence) =>
      /\bejemplo\b|\bpor ejemplo\b|\banalogia\b|\bimagina\b|\bcomo si\b/i.test(sentence),
    ) ?? extractSentences(quote.text)[0] ?? quote.text

    candidates.push({
      example: compact(exampleSentence),
      illustrates: compact(claimPool[0] ?? 'la afirmación principal mencionada en la evidencia'),
      evidenceQuoteIds: [quote.evidenceQuoteId],
    })
  }

  return unique(candidates.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item)).slice(0, 5)
}

function buildCandidateConsequences({
  claimPool,
  minimalEvidence,
  plan,
}: {
  claimPool: string[]
  minimalEvidence: MinimalEvidenceQuote[]
  plan?: ReasoningPlan
}): CandidateConsequence[] {
  const candidates: CandidateConsequence[] = []

  for (const item of plan?.items ?? []) {
    const consequencePoint = item.supportingPoints.find((point) =>
      isConsequenceText(point),
    )
    if (consequencePoint) {
      candidates.push({
        causeOrInput: compact(item.coreClaim),
        consequence: compact(consequencePoint),
        whyItMatters: compact(item.whyItMatters),
        evidenceQuoteIds: item.citations.slice(0, 2).map((_, index) => `Q${index + 1}`),
      })
    }
  }

  for (const quote of minimalEvidence) {
    const consequenceSentence = firstSentenceMatching(quote.text, /\binefici|\bfrustr|\blimita\b|\bimplica\b|\bresultado\b|\bconsecuencia\b|\bpor eso\b|\bpor lo tanto\b|\belimina\b|\breduce\b/)
    if (!consequenceSentence) {
      continue
    }
    const causeSentence = extractSentences(quote.text)[0] ?? quote.text
    candidates.push({
      causeOrInput: compact(causeSentence),
      consequence: compact(consequenceSentence),
      whyItMatters: compact(consequenceSentence),
      evidenceQuoteIds: [quote.evidenceQuoteId],
    })
  }

  return unique(candidates.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item)).slice(0, 5)
}

export function buildEvidenceDerivedPromptHints({
  currentExtraction,
  minimalEvidence,
  plan,
  critique,
}: {
  currentExtraction: GroundedWindowExtraction
  minimalEvidence: MinimalEvidenceQuote[]
  plan?: ReasoningPlan
  critique?: SemanticCritique
}): EvidenceDerivedPromptHints {
  const weightedSources: Array<{ text: string; weight: number }> = []

  for (const block of currentExtraction.noteBlocks) {
    weightedSources.push({ text: block.heading, weight: 4 })
    weightedSources.push({ text: block.content, weight: 2 })
  }

  for (const quote of minimalEvidence) {
    weightedSources.push({ text: quote.text, weight: 3 })
  }

  for (const item of plan?.items ?? []) {
    weightedSources.push({ text: item.title, weight: 5 })
    weightedSources.push({ text: item.coreClaim, weight: 4 })
    weightedSources.push({ text: item.whyItMatters, weight: 3 })
    weightedSources.push({ text: item.supportingPoints.join(' '), weight: 2 })
  }

  for (const block of critique?.weakBlocks ?? []) {
    weightedSources.push({ text: block.heading, weight: 3 })
    weightedSources.push({ text: block.issue, weight: 2 })
    weightedSources.push({ text: block.fix, weight: 2 })
  }

  for (const priority of critique?.rewritePriorities ?? []) {
    weightedSources.push({ text: priority, weight: 1 })
  }

  const domainVocabulary = scoreTerms(weightedSources)
  const candidateClaims = buildClaimPool({ currentExtraction, plan })
  const candidateContrasts = buildCandidateContrasts({ plan, minimalEvidence })
  const candidateObjections = buildCandidateObjections({ claimPool: candidateClaims, minimalEvidence })
  const candidateExamples = buildCandidateExamples({ claimPool: candidateClaims, minimalEvidence })
  const candidateConsequences = buildCandidateConsequences({ claimPool: candidateClaims, minimalEvidence, plan })

  return {
    domainVocabulary,
    allowedSystemTerms: ALLOWED_SYSTEM_TERMS,
    candidateClaims,
    candidateContrasts,
    candidateObjections,
    candidateExamples,
    candidateConsequences,
  }
}
