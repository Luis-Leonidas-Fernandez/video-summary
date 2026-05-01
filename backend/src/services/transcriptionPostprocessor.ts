function normalizeFragment(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeFragment(value)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

function similarityScore(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function areNearDuplicates(left: string, right: string): boolean {
  const normalizedLeft = normalizeFragment(left);
  const normalizedRight = normalizeFragment(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  if (normalizedLeft === normalizedRight) {
    return true;
  }

  if (
    normalizedLeft.length > 24 &&
    normalizedRight.length > 24 &&
    (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))
  ) {
    return true;
  }

  return similarityScore(left, right) >= 0.9;
}

function dedupeConsecutiveFragments(fragments: string[]): string[] {
  const result: string[] = [];

  for (const fragment of fragments) {
    const trimmed = fragment.trim();
    if (!trimmed) {
      continue;
    }

    const previous = result[result.length - 1];
    if (previous && areNearDuplicates(previous, trimmed)) {
      continue;
    }

    result.push(trimmed);
  }

  return result;
}

function dedupeRepeatedRuns(fragments: string[]): string[] {
  const result = [...fragments];

  for (let windowSize = 1; windowSize <= 3; windowSize += 1) {
    let index = 0;

    while (index + windowSize * 2 <= result.length) {
      let isDuplicateWindow = true;

      for (let offset = 0; offset < windowSize; offset += 1) {
        if (!areNearDuplicates(result[index + offset], result[index + windowSize + offset])) {
          isDuplicateWindow = false;
          break;
        }
      }

      if (isDuplicateWindow) {
        result.splice(index + windowSize, windowSize);
        continue;
      }

      index += 1;
    }
  }

  return result;
}

function splitIntoSentences(line: string): string[] {
  return line
    .split(/(?<=[.!?…])\s+/u)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
}

function cleanLine(line: string): string {
  const sentences = splitIntoSentences(line);
  const cleanedSentences = dedupeRepeatedRuns(dedupeConsecutiveFragments(sentences));
  return cleanedSentences.join(' ').trim();
}

export function postprocessTranscription(rawTranscription: string): string {
  const lines = rawTranscription
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(cleanLine)
    .filter(Boolean);

  const dedupedLines = dedupeRepeatedRuns(dedupeConsecutiveFragments(lines));
  return `${dedupedLines.join('\n')}\n`;
}
