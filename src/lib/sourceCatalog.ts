export interface SourceCatalogItem {
  id: string;
  name?: string;
  url?: string;
  type?: string;
  status?: string;
  localScraperId?: string;
  relevanceScore?: number;
  listSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
}

function normalizeSourceKey(value?: string) {
  return `${value || ''}`.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function getCanonicalSourceKey(source: SourceCatalogItem) {
  const scraperKey = normalizeSourceKey(source.localScraperId);
  if (scraperKey) return scraperKey;

  const nameKey = normalizeSourceKey(source.name);
  if (nameKey.includes('thebell') || nameKey.includes('더벨')) return 'thebell';
  if (nameKey.includes('marketinsight') || nameKey.includes('마켓인사이트')) return 'marketinsight';

  try {
    const hostname = new URL(source.url || '').hostname.replace(/^www\./, '');
    if (hostname.includes('thebell.co.kr')) return 'thebell';
    if (hostname.includes('marketinsight.hankyung.com')) return 'marketinsight';
    return `${nameKey}:${hostname}`;
  } catch {
    return nameKey || source.id;
  }
}

function scoreSource(source: SourceCatalogItem) {
  let score = 0;
  if (source.status === 'active') score += 100;
  if (source.type === 'scraping') score += 60;
  if (source.localScraperId) score += 40;
  if (source.listSelector && source.titleSelector && source.linkSelector) score += 20;
  score += Number(source.relevanceScore || 0);
  return score;
}

export function dedupeSourceCatalog<T extends SourceCatalogItem>(sources: T[]) {
  const picked = new Map<string, T>();

  for (const source of sources) {
    const key = getCanonicalSourceKey(source);
    const current = picked.get(key);
    if (!current || scoreSource(source) > scoreSource(current)) {
      picked.set(key, source);
    }
  }

  return Array.from(picked.values());
}

export function getSourceOriginLabel(source: SourceCatalogItem) {
  const scraperKey = normalizeSourceKey(source.localScraperId);
  if (scraperKey === 'thebell' || scraperKey === 'marketinsight') {
    return '외부 스크래핑';
  }
  if (source.type === 'scraping') return '스크래핑';
  if (source.type === 'rss') return 'RSS';
  if (source.type === 'api') return 'API';
  return null;
}
