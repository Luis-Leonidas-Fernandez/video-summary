import type { ValidationMatch, ValidationSignal } from './studyValidationTypes.js'

interface AliasGroup {
  canonical: string
  aliases: string[]
}

interface SemanticHeadingRule {
  labelPatterns: string[]
  sourcePatterns: string[]
  reason: string
}

const DOMAIN_ALIAS_GROUPS: AliasGroup[] = [
  { canonical: 'eusebio', aliases: ['eusebio', 'eusebio de cesarea'] },
  { canonical: 'ireneo', aliases: ['ireneo', 'san ireneo de lyon', 'san ireneo de leon'] },
  { canonical: 'clemente', aliases: ['clemente', 'san clemente romano'] },
  { canonical: 'nicea', aliases: ['nicea', 'concilio de nicea'] },
  { canonical: 'obispo', aliases: ['obispo', 'episcopado'] },
  { canonical: 'obispo de roma', aliases: ['obispo de roma', 'sede romana', 'autoridad romana', 'catedra de pedro'] },
  { canonical: 'presbitero', aliases: ['presbitero', 'anciano'] },
]

const GENERIC_LABELS = new Set([
  'titulo probable',
  'contenido explicado',
  'vacios o ambiguedades',
  'ambiguedades o dudas',
  'tema 1',
  'tema 2',
  'tema 3',
  'tema 4',
  'tema 5',
])

const PEDAGOGICAL_LABEL_PATTERNS = [
  'introduccion',
  'definicion',
  'explicacion',
  'concepto',
  'resumen',
  'conclusion',
  'ejemplo',
  'materiales de estudio',
  'apertura del curso',
]

const SEMANTIC_HEADING_RULES: SemanticHeadingRule[] = [
  {
    labelPatterns: ['emisor'],
    sourcePatterns: ['transmite el mensaje', 'envia el mensaje', 'codifica el mensaje', 'quien habla', 'quien comunica'],
    reason: 'La transcripción menciona a quien codifica o transmite el mensaje.',
  },
  {
    labelPatterns: ['receptor'],
    sourcePatterns: ['recibe el mensaje', 'decodifica el mensaje', 'quien escucha', 'destinatario'],
    reason: 'La transcripción menciona a quien recibe o decodifica el mensaje.',
  },
  {
    labelPatterns: ['canal'],
    sourcePatterns: ['medio por el cual', 'medio de transmision', 'canal de comunicacion'],
    reason: 'La transcripción explica el medio o canal de comunicación.',
  },
  {
    labelPatterns: ['codigo'],
    sourcePatterns: ['sistema de signos', 'lenguaje utilizado', 'codigo compartido'],
    reason: 'La transcripción explica el código o lenguaje compartido del acto comunicativo.',
  },
  {
    labelPatterns: ['feedback', 'retroalimentacion'],
    sourcePatterns: ['retroalimentacion', 'respuesta del receptor', 'devolucion'],
    reason: 'La transcripción describe la retroalimentación o respuesta dentro del circuito comunicacional.',
  },
  {
    labelPatterns: ['ruido'],
    sourcePatterns: ['interferencia', 'perturbacion', 'obstaculo', 'dificulta la comunicacion'],
    reason: 'La transcripción describe el ruido como interferencia u obstáculo para la comunicación.',
  },
  {
    labelPatterns: ['filtro'],
    sourcePatterns: ['condiciona la recepcion', 'altera la recepcion', 'interpreta el mensaje', 'percepcion'],
    reason: 'La transcripción describe el filtro como algo que condiciona o altera la recepción.',
  },
  {
    labelPatterns: ['barrera'],
    sourcePatterns: ['impedimento', 'obstaculo', 'dificultad comunicacional', 'barrera comunicacional'],
    reason: 'La transcripción describe la barrera como impedimento u obstáculo comunicacional.',
  },
  {
    labelPatterns: ['axioma'],
    sourcePatterns: ['principio', 'postulado', 'regla base', 'no se puede no comunicar'],
    reason: 'La transcripción presenta el axioma como principio o postulado base.',
  },
  {
    labelPatterns: ['conclusion'],
    sourcePatterns: ['cierre', 'recapitulacion', 'para finalizar', 'en conclusion'],
    reason: 'La transcripción contiene un cierre o recapitulación final.',
  },
  {
    labelPatterns: ['definicion de comunicacion', 'comunicacion'],
    sourcePatterns: ['comunicacion', 'proceso comunicativo', 'acto comunicativo'],
    reason: 'La transcripción desarrolla el concepto de comunicación.',
  },
  {
    labelPatterns: ['introduccion al curso', 'materiales de estudio', 'introduccion al curso y materiales de estudio'],
    sourcePatterns: ['curso', 'material', 'cuadernillo', 'bibliografia', 'programa', 'clase', 'presentacion del curso'],
    reason: 'La transcripción presenta el curso o los materiales de estudio de manera introductoria.',
  },
]

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s:.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeLabel(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[:：.;,()[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function singularizeBasic(label: string): string {
  if (label.endsWith('es')) return label.slice(0, -2)
  if (label.endsWith('s')) return label.slice(0, -1)
  return label
}

function getLabelVariants(label: string): string[] {
  const normalized = normalizeLabel(label)
  const singularized = singularizeBasic(normalized)
  return [...new Set([normalized, singularized].filter(Boolean))]
}

export function extractLabels(content: string): string[] {
  const labels: string[] = []

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const headingMatch = line.match(/^###\s+(.+)$/)
    if (headingMatch?.[1]) {
      labels.push(headingMatch[1].trim())
      continue
    }

    const boldLabelMatch = line.match(/^[-*]\s+\*\*(.+?)\*\*:?/)
    if (boldLabelMatch?.[1]) {
      labels.push(boldLabelMatch[1].trim())
      continue
    }

    const colonMatch = line.match(/^[-*]\s+([^:]{3,80}):\s+/)
    if (colonMatch?.[1]) {
      labels.push(colonMatch[1].trim())
    }
  }

  return labels.filter((label) => !GENERIC_LABELS.has(normalizeLabel(label)))
}

function hasLiteralMatch(source: string, label: string): ValidationMatch | null {
  const normalizedLabel = normalizeLabel(label)
  if (!normalizedLabel) {
    return {
      label,
      normalizedLabel,
      matchType: 'literal_match',
      reason: 'El label quedó vacío después de normalizar, así que no aporta señal de deriva.',
    }
  }

  for (const variant of getLabelVariants(label)) {
    if (source.includes(variant)) {
      return {
        label,
        normalizedLabel,
        matchType: 'literal_match',
        reason: variant === normalizedLabel
          ? 'El label aparece literalmente en la transcripción.'
          : 'El label matchea literalmente a través de una variante morfológica auxiliar.',
      }
    }
  }

  const meaningfulTokens = normalizedLabel.split(' ').filter((token) => token.length >= 4)
  if (meaningfulTokens.length === 0) {
    return {
      label,
      normalizedLabel,
      matchType: 'literal_match',
      reason: 'El label no tiene tokens significativos para cuestionarlo.',
    }
  }

  return null
}

function getAliasMatch(source: string, label: string): ValidationMatch | null {
  const normalizedLabel = normalizeLabel(label)
  const variants = getLabelVariants(label)

  for (const group of DOMAIN_ALIAS_GROUPS) {
    const labelMatchesGroup = group.aliases.some((alias) => variants.includes(normalizeLabel(alias)))
    if (!labelMatchesGroup) continue

    const sourceAlias = group.aliases.find((alias) => source.includes(normalizeText(alias)))
    if (!sourceAlias) continue

    return {
      label,
      normalizedLabel,
      matchType: 'alias_match',
      reason: `El label matchea por alias contextual con "${sourceAlias}" dentro del grupo "${group.canonical}".`,
    }
  }

  return null
}

function getSemanticHeadingMatch(source: string, label: string): ValidationMatch | null {
  const normalizedLabel = normalizeLabel(label)
  const variants = getLabelVariants(label)

  for (const rule of SEMANTIC_HEADING_RULES) {
    const normalizedPatterns = rule.labelPatterns.map((pattern) => normalizeLabel(pattern))
    const labelMatchesRule = normalizedPatterns.some((pattern) => variants.includes(pattern))
    if (!labelMatchesRule) continue

    const sourceMatchesRule = rule.sourcePatterns.some((pattern) => source.includes(normalizeText(pattern)))
    if (!sourceMatchesRule) continue

    return {
      label,
      normalizedLabel,
      matchType: 'semantic_heading_match',
      reason: rule.reason,
    }
  }

  const isPedagogicalHeading = PEDAGOGICAL_LABEL_PATTERNS.some((pattern) => normalizedLabel.includes(pattern))
  if (!isPedagogicalHeading) {
    return null
  }

  const meaningfulTokens = normalizedLabel.split(' ').filter((token) => token.length >= 5)
  const overlapCount = meaningfulTokens.filter((token) => source.includes(token)).length

  if (overlapCount >= 1) {
    return {
      label,
      normalizedLabel,
      matchType: 'semantic_heading_match',
      reason: 'El label parece un heading pedagógico y comparte vocabulario temático con la transcripción.',
    }
  }

  return null
}

function getLabelSkeleton(label: string): string | null {
  const tokens = normalizeLabel(label).split(' ').filter(Boolean)
  if (tokens.length < 2) return null

  const taxonomyPrefixes = ['rito de', 'tipo de', 'clase de', 'categoria de', 'variante de']
  const normalized = tokens.join(' ')
  for (const prefix of taxonomyPrefixes) {
    if (normalized.startsWith(prefix)) {
      return `${prefix} *`
    }
  }

  if (tokens.length >= 3 && tokens.includes('de')) {
    const copy = [...tokens]
    copy[copy.length - 1] = '*'
    return copy.join(' ')
  }

  return null
}

export function detectStructuralSignals(extraction: string, normalizedSource: string): ValidationSignal[] {
  const signals: ValidationSignal[] = []
  const patternCounts = new Map<string, number>()
  let currentSkeleton: string | null = null
  let currentCount = 0

  for (const rawLine of extraction.split(/\r?\n/)) {
    const label = extractLabels(rawLine)[0] ?? rawLine.trim()
    const skeleton = getLabelSkeleton(label)

    if (!skeleton) {
      currentSkeleton = null
      currentCount = 0
      continue
    }

    currentCount = skeleton === currentSkeleton ? currentCount + 1 : 1
    currentSkeleton = skeleton
    patternCounts.set(skeleton, Math.max(patternCounts.get(skeleton) ?? 0, currentCount))

    if (currentCount > 8) {
      signals.push({
        type: 'pattern_explosion',
        severity: 'strong',
        label,
        reason: `Se detectó una explosión de patrón para "${skeleton}" con ${currentCount} líneas consecutivas.`,
      })
    }
  }

  for (const [pattern, count] of patternCounts.entries()) {
    if (count < 5) continue

    const patternPrefix = pattern.replace('*', '').trim()
    const sourceMentions = normalizedSource.includes(patternPrefix)

    if (/^(rito de|tipo de|clase de|categoria de|variante de)\s+\*/.test(pattern) && !sourceMentions) {
      signals.push({
        type: 'artificial_taxonomy',
        severity: 'strong',
        label: pattern,
        reason: `Se detectó una taxonomía artificial "${pattern}" repetida ${count} veces sin apoyo claro en la transcripción.`,
      })
      continue
    }

    if (count > 8 && !sourceMentions) {
      signals.push({
        type: 'pattern_explosion',
        severity: 'strong',
        label: pattern,
        reason: `El patrón "${pattern}" se repite ${count} veces y no tiene correlato suficiente en la transcripción.`,
      })
    }
  }

  return signals
}

export function matchLabel(source: string, label: string): ValidationMatch {
  const normalizedLabel = normalizeLabel(label)
  const literalMatch = hasLiteralMatch(source, label)
  if (literalMatch) return literalMatch

  const aliasMatch = getAliasMatch(source, label)
  if (aliasMatch) return aliasMatch

  const semanticMatch = getSemanticHeadingMatch(source, label)
  if (semanticMatch) return semanticMatch

  const meaningfulTokens = normalizedLabel.split(' ').filter((token) => token.length >= 4)
  const tokenMatches = meaningfulTokens.filter((token) => source.includes(token)).length
  if (meaningfulTokens.length > 0 && tokenMatches >= Math.min(2, meaningfulTokens.length)) {
    return {
      label,
      normalizedLabel,
      matchType: 'semantic_heading_match',
      reason: 'El label comparte suficientes tokens significativos con la transcripción como apoyo semántico auxiliar.',
    }
  }

  return {
    label,
    normalizedLabel,
    matchType: 'unmatched',
    reason: 'No hubo match literal, por alias ni por heading semántico liviano.',
  }
}

export function buildMatchSignals(matches: ValidationMatch[]): ValidationSignal[] {
  return matches.map((match) => ({
    type: match.matchType,
    severity: match.matchType === 'unmatched' ? 'warning' : 'info',
    label: match.label,
    reason: match.reason,
  }))
}
