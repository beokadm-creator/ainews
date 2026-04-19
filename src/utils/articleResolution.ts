export function resolveArticleIdByUrl(href: string, articles: any[]): string | null {
  if (!href || href.startsWith('javascript') || href.startsWith('#')) return null;
  const match = articles.find((a) => {
    if (!a.url) return false;
    try {
      const aUrl = new URL(a.url);
      const hUrl = new URL(href);
      if (aUrl.hostname !== hUrl.hostname) return false;
      const aPath = aUrl.pathname.replace(/\/$/, '');
      const hPath = hUrl.pathname.replace(/\/$/, '');
      if (aPath !== hPath) return false;
      if (aUrl.search && hUrl.search) {
        const aParams = new URLSearchParams(aUrl.search);
        const hParams = new URLSearchParams(hUrl.search);
        if (aParams.get('id') && aParams.get('id') === hParams.get('id')) return true;
        if (aParams.get('no') && aParams.get('no') === hParams.get('no')) return true;
        if (aParams.get('article_id') && aParams.get('article_id') === hParams.get('article_id')) return true;
      }
      return true;
    } catch {
      return a.url === href;
    }
  });
  return match?.id || null;
}

export function resolveArticleIdByHeadline(text: string, articles: any[]): string | null {
  if (!text || text.length < 2) return null;
  const normalize = (s: string) => (s || '').replace(/[\s\p{P}]/gu, '').toLowerCase();
  const searchNorm = normalize(text);
  const exactMatch = articles.find((a) => normalize(a.title) === searchNorm);
  if (exactMatch) return exactMatch.id;
  const getBigrams = (s: string) => {
    const bg = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) bg.add(s.substring(i, i + 2));
    return bg;
  };
  const searchBg = getBigrams(searchNorm);
  if (searchBg.size === 0) return null;
  let bestMatch: any = null;
  let maxOverlap = 0;
  for (const a of articles) {
    const titleNorm = normalize(a.title);
    if (titleNorm.includes(searchNorm) || searchNorm.includes(titleNorm)) {
      return a.id;
    }
    const titleBg = getBigrams(titleNorm);
    let intersection = 0;
    for (const bg of searchBg) if (titleBg.has(bg)) intersection++;
    const dice = (2.0 * intersection) / (searchBg.size + titleBg.size);
    if (dice > maxOverlap) {
      maxOverlap = dice;
      bestMatch = a;
    }
  }
  if (bestMatch && maxOverlap >= 0.6) return bestMatch.id || null;
  return null;
}
