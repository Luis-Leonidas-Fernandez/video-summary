import { jsonrepair } from 'jsonrepair'

export type RobustParseStrategy = 'plain_json' | 'substring_json' | 'jsonrepair'

export type JsonObjectParseResult =
  | { ok: true; value: Record<string, unknown>; strategy: RobustParseStrategy; repairedJsonText?: string }
  | { ok: false; error: string; rawPreview: string }

function extractBalancedJsonObject(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start === -1) {
    return null
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === '\\') {
        escaped = true
        continue
      }

      if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{') {
      depth += 1
      continue
    }

    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        return raw.slice(start, index + 1).trim()
      }
    }
  }

  return null
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim()
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  return trimmed
}

function extractFirstToLastBrace(raw: string): string | null {
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) {
    return null
  }

  return raw.slice(first, last + 1).trim()
}

function uniqueCandidates(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []

  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }

    seen.add(trimmed)
    ordered.push(trimmed)
  }

  return ordered
}

function buildParseCandidates(raw: string): Array<{ text: string; strategy: Exclude<RobustParseStrategy, 'jsonrepair'> }> {
  const stripped = stripCodeFences(raw)
  const balanced = extractBalancedJsonObject(stripped)
  const firstToLast = extractFirstToLastBrace(stripped)

  return uniqueCandidates([stripped, balanced, firstToLast]).map((text, index) => ({
    text,
    strategy: index === 0 ? 'plain_json' : 'substring_json',
  }))
}

function tryParseObject(text: string): Record<string, unknown> | null {
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }

  return parsed as Record<string, unknown>
}

export function parseJsonObjectRobust(raw: string): JsonObjectParseResult {
  const candidates = buildParseCandidates(raw)
  let lastError = 'Respuesta vacía o no reconocible como JSON.'

  for (const candidate of candidates) {
    try {
      const parsed = tryParseObject(candidate.text)
      if (!parsed) {
        lastError = 'La respuesta JSON no es un objeto.'
        continue
      }

      return {
        ok: true,
        value: parsed,
        strategy: candidate.strategy,
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Error desconocido al parsear JSON.'
    }
  }

  for (const candidate of candidates) {
    try {
      const repaired = jsonrepair(candidate.text)
      const parsed = tryParseObject(repaired)
      if (!parsed) {
        lastError = 'La respuesta reparada no es un objeto.'
        continue
      }

      return {
        ok: true,
        value: parsed,
        strategy: 'jsonrepair',
        repairedJsonText: repaired,
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Error desconocido al reparar JSON.'
    }
  }

  return {
    ok: false,
    error: lastError,
    rawPreview: raw.slice(0, 800),
  }
}
