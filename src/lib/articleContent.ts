const NOISE_LINE_PATTERNS = [
  /^다른기사\s*보기$/i,
  /^지금\s*인기\s*있는\s*기사$/i,
  /^Pin'?s\s*Pick$/i,
  /^저작권자\s*[©\s]/i,
  /^무단전재\s*및\s*재배포\s*금지/i,
  /^기사제보/i,
  /^바로가기$/i,
  /^\d+\s*$/,
];

const INLINE_CUTOFF_PATTERNS = [
  /저작권자\s*[©\s]/i,
  /무단전재\s*및\s*재배포\s*금지/i,
  /지금\s*인기\s*있는\s*기사/i,
  /Pin'?s\s*Pick/i,
  /다른기사\s*보기/i,
];

function normalizeLine(value: string) {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function normalizeArticleContent(value: string) {
  const normalized = `${value || ''}`
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return '';

  const cutoffIndex = INLINE_CUTOFF_PATTERNS
    .map((pattern) => normalized.search(pattern))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  const sliced = typeof cutoffIndex === 'number' ? normalized.slice(0, cutoffIndex) : normalized;

  return sliced
    .split(/\n{1,2}/)
    .map(normalizeLine)
    .filter((line) => line && !NOISE_LINE_PATTERNS.some((pattern) => pattern.test(line)))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLongParagraph(paragraph: string) {
  const compact = paragraph.replace(/\s+/g, ' ').trim();
  if (compact.length <= 220) return [compact];

  const sentences = compact.split(/(?<=[.!?]|[다요죠]\.|니다\.|입니다\.|했다\.|했다\!|했다\?)\s+/);
  if (sentences.length <= 1) return [compact];

  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > 220 && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export function formatArticleContentParagraphs(value: string) {
  const normalized = normalizeArticleContent(value);
  if (!normalized) return [];

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap(splitLongParagraph);
}
