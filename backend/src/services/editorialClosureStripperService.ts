import { jobLog } from '../utils/jobContext.js'
import type { WindowDraftExtraction } from './windowDraftNormalizerService.js'

const FULL_SENTENCE_CLOSURE_PATTERNS: RegExp[] = [
  /^(Esta|Este|Ello|Eso|Esa)\s+\S+\s+(sugiere|indica|demuestra|implica|muestra|refleja|evidencia)/i,
  /^(Por lo tanto|Por ende|En consecuencia|De este modo|De esta manera|Así|Por consiguiente)\b/i,
  /\b(lo que sugiere que|lo que indica que|lo que demuestra que|lo que implica que|lo que muestra que|lo que refleja que)\b/i,
  /\b(es importante considerar|es importante destacar|es importante recordar|es crucial|es fundamental|cabe destacar|cabe mencionar)\b/i,
  /^(La|El|Las|Los|Una|Un)\s+[\wáéíóúüñÁÉÍÓÚÜÑ]+(\s+[\wáéíóúüñÁÉÍÓÚÜÑ\s,]+)?\s+(sugiere|sugieren|indica|indican|demuestra|demuestran|implica|implican|refleja|reflejan|muestra|muestran|revela|revelan|evidencia|evidencian)\b/i,
  /^(Quizás|Tal vez|Posiblemente|Probablemente)\b/i,
]

const TRAILING_GERUND_PATTERN = /,\s+(indicando|sugiriendo|mostrando|demostrando|marcando|revelando|implicando|evidenciando|reflejando|señalando|apuntando|ilustrando|denotando)\b[^.]*\.?\s*$/i

const MIN_ITEM_TEXT_LENGTH = 30

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=\.)\s+(?=[A-ZÁÉÍÓÚÜÑ])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function isFullSentenceClosure(sentence: string): boolean {
  return FULL_SENTENCE_CLOSURE_PATTERNS.some((pattern) => pattern.test(sentence))
}

function stripTrailingGerundClause(sentence: string): { text: string; removed: boolean } {
  if (!TRAILING_GERUND_PATTERN.test(sentence)) {
    return { text: sentence, removed: false }
  }
  const cleaned = sentence.replace(TRAILING_GERUND_PATTERN, '').trim()
  const finalText = cleaned.endsWith('.') ? cleaned : `${cleaned}.`
  if (finalText.length < MIN_ITEM_TEXT_LENGTH) {
    return { text: sentence, removed: false }
  }
  return { text: finalText, removed: true }
}

interface ProcessedItem {
  text: string
  fullSentenceStripped: boolean
  gerundClauseStripped: boolean
}

function processItemText(text: string): ProcessedItem {
  const sentences = splitIntoSentences(text)
  if (sentences.length === 0) {
    return { text, fullSentenceStripped: false, gerundClauseStripped: false }
  }

  const lastIndex = sentences.length - 1
  const lastSentence = sentences[lastIndex]

  const { text: lastWithoutGerund, removed: gerundRemoved } = stripTrailingGerundClause(lastSentence)
  const effectiveLast = gerundRemoved ? lastWithoutGerund : lastSentence

  if (sentences.length > 1 && isFullSentenceClosure(effectiveLast)) {
    const stripped = sentences.slice(0, -1).join(' ').trim()
    if (stripped.length >= MIN_ITEM_TEXT_LENGTH) {
      return { text: stripped, fullSentenceStripped: true, gerundClauseStripped: gerundRemoved }
    }
  }

  if (gerundRemoved) {
    const rebuilt = [...sentences.slice(0, -1), lastWithoutGerund].join(' ').trim()
    return { text: rebuilt, fullSentenceStripped: false, gerundClauseStripped: true }
  }

  return { text, fullSentenceStripped: false, gerundClauseStripped: false }
}

export function stripEditorialClosures(draft: WindowDraftExtraction): WindowDraftExtraction {
  let fullSentencesStripped = 0
  let trailingGerundsStripped = 0

  const items = draft.items.map((item) => {
    const result = processItemText(item.text)
    if (result.fullSentenceStripped) fullSentencesStripped += 1
    if (result.gerundClauseStripped) trailingGerundsStripped += 1
    return { ...item, text: result.text }
  })

  if (fullSentencesStripped > 0 || trailingGerundsStripped > 0) {
    jobLog(`[closure-stripper] full_sentences=${fullSentencesStripped} trailing_gerunds=${trailingGerundsStripped} items=${draft.items.length}`)
  }

  return {
    ...draft,
    items,
  }
}
