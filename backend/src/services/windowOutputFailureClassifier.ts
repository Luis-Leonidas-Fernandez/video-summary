import type { GroundedWindowExtraction, WindowOutputFailureKind } from './groundingTypes.js'

const ENGLISH_STOPWORDS = new Set([
  'the', 'and', 'with', 'without', 'for', 'from', 'into', 'through', 'about', 'against', 'between',
  'under', 'over', 'toward', 'towards', 'because', 'while', 'although', 'however', 'therefore',
  'saints', 'virgin', 'mary', 'intercession', 'common', 'misunderstandings', 'clarifications',
  'foundation', 'practical', 'considerations', 'conclusion',
])

const SPANISH_STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'para', 'por', 'con', 'sin', 'como', 'porque', 'aunque',
  'mientras', 'verdad', 'iglesia', 'dogma', 'santos', 'virgen', 'maría', 'intercesión',
  'necesidad', 'definición', 'respuesta', 'pilares', 'consideraciones', 'conclusión',
])

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length
}

function looksLikeTechnicalFallbackHeading(heading: string): boolean {
  return /^contenido no estructurado de c\d+/i.test(heading.trim())
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function computeLanguageSignal(text: string): { englishHits: number; spanishHits: number } {
  const tokens = tokenize(text)
  let englishHits = 0
  let spanishHits = 0

  for (const token of tokens) {
    if (ENGLISH_STOPWORDS.has(token)) englishHits += 1
    if (SPANISH_STOPWORDS.has(token)) spanishHits += 1
  }

  return { englishHits, spanishHits }
}

function looksClearlyEnglishText(text: string): boolean {
  const { englishHits, spanishHits } = computeLanguageSignal(text)
  return englishHits >= 2 && englishHits >= spanishHits + 2
}

export function classifyRawWindowOutputFailure(rawOutput: string, parseError?: string): WindowOutputFailureKind {
  const raw = rawOutput.trim()
  const error = (parseError ?? '').toLowerCase()

  if (!raw) {
    return 'non_json_text'
  }

  if (/^#+\s/m.test(raw) && /```(?:json)?/i.test(raw)) {
    return 'mixed_markdown_json'
  }

  if (/^```(?:json)?/i.test(raw)) {
    return 'markdown_wrapped'
  }

  if (/"topic"\s*:|"sections"\s*:|"references"\s*:|"keywords"\s*:|"description"\s*:/i.test(raw)) {
    return 'alternate_schema'
  }

  if (/\"[^\"]+\"\s*\n\s*[*-]/.test(raw) || /afirmaci[oó]n.*\"\s*\n\s*[*-]/i.test(raw)) {
    return 'pseudo_json_object_keys'
  }

  if (error.includes('unexpected end') || error.includes('end of json input')) {
    return 'truncated_json'
  }

  if (raw.includes('{') || raw.includes('[') || error.includes('json')) {
    return 'json_syntax'
  }

  return 'non_json_text'
}

export function classifyParsedWindowExtractionFailure(
  extraction: GroundedWindowExtraction,
): WindowOutputFailureKind | undefined {
  if (extraction.noteBlocks.length === 0) {
    return 'empty_blocks'
  }

  const fallbackLikeBlocks = extraction.noteBlocks.filter((block) =>
    looksLikeTechnicalFallbackHeading(block.heading) || countWords(block.content) < 20,
  ).length

  if (fallbackLikeBlocks >= Math.ceil(extraction.noteBlocks.length / 2)) {
    return 'technical_fallback_like_output'
  }

  const englishBlockCount = extraction.noteBlocks.filter((block) => {
    const headingClearlyEnglish = looksClearlyEnglishText(block.heading)
    const contentPreview = block.content.split(/\s+/).slice(0, 24).join(' ')
    const contentClearlyEnglish = looksClearlyEnglishText(contentPreview)
    return headingClearlyEnglish || contentClearlyEnglish
  }).length

  if (englishBlockCount > 0 && englishBlockCount >= Math.ceil(extraction.noteBlocks.length / 2)) {
    return 'language_drift'
  }

  return undefined
}
