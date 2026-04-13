import * as cheerio from 'cheerio';

const CONTENT_SELECTORS = [
  '.article-body',
  '.article-body__content',
  '.article-body__text',
  '.article-body-wrap',
  '.article-body-news',
  '.article-body-news-text',
  '.news_article',
  '.news_article_body',
  '.news_article_area',
  '.news-article',
  '.story-news-article',
  '.story-news-article__body',
  '.article-view-content-div',
  '.article__body',
  '.article__content',
  '.article__text',
  '.article_txt_wrap',
  '.article_txt_article',
  '.par',
  '[class*="article-body"]',
  '[class*="articleBody"]',
  '[class*="article__body"]',
  '[class*="article-content"]',
  '[class*="articleContent"]',
  '[class*="news-body"]',
  '[class*="newsBody"]',
  'article',
  '[itemprop="articleBody"]',
  '[data-testid="article-body"]',
  '.article_body',
  '.article-body',
  '.articleBody',
  '.article_view',
  '.article-view',
  '.article_txt',
  '.article-text',
  '.article_content',
  '.article-content',
  '.news_body',
  '.news-body',
  '.news_cnt_detail_wrap',
  '.news_cnt_detail',
  '.news-text',
  '.story-body',
  '.story-content',
  '.post-content',
  '.entry-content',
  '.view_cont',
  '.view_txt',
  '.news_view',
  '.contents',
  '#articleBody',
  '#article-body',
  '#newsView',
  '#news_body_id',
  '#content',
  'main',
  /저작권자\s*[©\s]/i,
  /무단전재\s*및\s*재배포\s*금지/i,
  /지금\s*인기\s*있는\s*기사/i,
  /Pin'?s\s*Pick/i,
  /다른기사\s*보기/i,
];

const REMOVE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'canvas',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'header',
  'footer',
  'nav',
  'aside',
  'figure figcaption',
  '.ad',
  '.ads',
  '.advertisement',
  '.article-ad',
  '.banner',
  '.promotion',
  '.subscribe',
  '.subscription',
  '.related',
  '.related-news',
  '.recommend',
  '.recommendation',
  '.popular',
  '.most-viewed',
  '.hotnews',
  '.live',
  '.breaking',
  '.photo',
  '.video',
  '.sns',
  '.share',
  '.reporter_info',
  '.copyright',
  '.byline',
  '.rank_news',
  '.news_list',
  '.keyword',
  '.breadcrumb',
  '[class*="related"]',
  '[class*="recommend"]',
  '[class*="popular"]',
  '[class*="rank"]',
  '[class*="best"]',
  '[class*="aside"]',
  '[class*="subscribe"]',
  '[class*="banner"]',
  '[class*="promo"]',
  '[class*="ad-"]',
  '[id*="related"]',
  '[id*="recommend"]',
  '[id*="popular"]',
  '[id*="rank"]',
  'section[aria-label*="related" i]',
  'section[aria-label*="recommend" i]',
  '[role="navigation"]',
  '[aria-label*="share" i]',
  '[aria-label*="menu" i]',
];

const NOISE_LINE_PATTERNS = [
  /^닫기\s*실시간뉴스/i,
  /^실시간뉴스/i,
  /^구독\s*지면/i,
  /^My\s/i,
  /^로그인\s*로그아웃/i,
  /^menu$/i,
  /^power by/i,
  /^search$/i,
  /^주요뉴스/i,
  /^실시간급상승 뉴스/i,
  /^오늘의포토/i,
  /^당신을 위한맞춤 뉴스/i,
  /^소셜 많이 본 뉴스/i,
  /^뉴스레터/i,
  /^바이오 투자 길라잡이/i,
  /^MICE 최신정보를 한눈에/i,
  /^재미에 지식을 더하다/i,
  /^두근두근 핫포토/i,
  /^당신의 드림카는/i,
  /^이슈기획/i,
  /^오늘의 주요 기사/i,
  /^알립니다/i,
  /^IR 멤버스/i,
  /^이데일리ON/i,
  /^문화 · 행사/i,
  /^Family site/i,
  /^회사소개$/i,
  /^회사공고$/i,
  /^오시는길$/i,
  /^업무문의$/i,
  /^이용약관$/i,
  /^청소년보호정책/i,
  /^고충처리인제도안내/i,
  /^저작권보호$/i,
  /^오류제보$/i,
  /^기사제보$/i,
  /^개인정보처리방침$/i,
  /^All rights reserved/i,
  /^저작권자\s*©/i,
  /^무단전재,\s*재배포 금지/i,
];

const CUTOFF_PATTERNS = [
  /저작권자\s*©/i,
  /무단전재,\s*재배포\s*금지/i,
  /뉴스레터\s*구독/i,
  /실시간급상승 뉴스/i,
  /오늘의포토/i,
  /당신을 위한맞춤 뉴스/i,
  /소셜 많이 본 뉴스/i,
  /Family site/i,
  /All rights reserved/i,
  /회사소개\s+회사공고\s+오시는길/i,
];

function normalizeLine(line: string): string {
  return line
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function getHostname(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isSectionLabelLine(line: string): boolean {
  return new Set([
    '\uACBD\uC81C',
    '\uAD6D\uC81C',
    '\uC0B0\uC5C5',
    '\uAE30\uC5C5',
    '\uC99D\uAD8C',
    '\uC815\uCE58',
    '\uC0AC\uD68C',
    '\uBB38\uD654',
    '\uC624\uD53C\uB2C8\uC5B8',
    '\uB9C8\uCF13\uC2DC\uADF8\uB110',
    '\uC2DC\uC7A5\uC758 \uB9E5',
    '\uAE30\uC790\uC218\uCCA9',
  ]).has(line);
}

function looksLikeHeadlineCluster(line: string): boolean {
  const ellipsisCount = (line.match(/\u2026/g) || []).length;
  const quoteCount = (line.match(/["'\u201C\u201D\u2018\u2019]/g) || []).length;
  const hasRankingPrefix = /^\d{1,2}\s+/.test(line);
  const hasRepeatedHeadlineSignals =
    ellipsisCount >= 2 ||
    quoteCount >= 4 ||
    /(\uD83D\uDD25|\uD504\uB85C\uC57C\uAD6C|\uC720\uD615 \uD14C\uC2A4\uD2B8)/.test(line);

  if (hasRankingPrefix) return true;
  if (isSectionLabelLine(line)) return true;
  if (hasRepeatedHeadlineSignals && line.length >= 40) return true;

  return false;
}

function stripKnownLeadingNoise(lines: string[], hostname: string): string[] {
  if (!lines.length) return lines;

  return lines.filter((line, index) => {
    if (!line) return false;

    if (
      hostname.includes('sedaily.com') &&
      index < 3 &&
      /\uAC00\s+\uBCF4\uD1B5.*\uAC00\s+\uD06C\uAC8C.*\uAC00\s+\uC544\uC8FC\s+\uD06C\uAC8C.*\uC5D1\uC2A4.*\uC774\uBA54\uC77C/.test(line)
    ) {
      return false;
    }

    return true;
  });
}

function stripKnownTrailingNoise(lines: string[], hostname: string): string[] {
  if (!lines.length) return lines;

  const cleaned: string[] = [];
  const seen = new Set<string>();
  let bodyChars = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const next = lines[i + 1] || '';
    const next2 = lines[i + 2] || '';
    const next3 = lines[i + 3] || '';

    if (bodyChars >= 120) {
      const upcomingClusterScore = [line, next, next2, next3]
        .filter(Boolean)
        .reduce((count, candidate) => count + (looksLikeHeadlineCluster(candidate) ? 1 : 0), 0);

      const repeatedLine = seen.has(line) && line.length >= 20;
      const sedailyFooterStart = hostname.includes('sedaily.com')
        && isSectionLabelLine(next)
        && next2.length >= 20;

      if (repeatedLine || upcomingClusterScore >= 2 || sedailyFooterStart) {
        break;
      }
    }

    cleaned.push(line);
    seen.add(line);
    bodyChars += line.length;
  }

  return cleaned;
}

function applySiteSpecificTextCleanup(text: string, url?: string): string {
  const hostname = getHostname(url);
  if (!hostname) return text;

  let lines = text
    .split(/\n{2,}/)
    .map(normalizeLine)
    .filter(Boolean);

  if (
    hostname.includes('asiae.co.kr') ||
    hostname.includes('sedaily.com') ||
    hostname.includes('fnnews.com') ||
    hostname.includes('mt.co.kr') ||
    hostname.includes('moneytoday.co.kr') ||
    hostname.includes('chosun.com') ||
    hostname.includes('chosunbiz.com') ||
    hostname.includes('biz.chosun.com')
  ) {
    lines = stripKnownLeadingNoise(lines, hostname);
    lines = stripKnownTrailingNoise(lines, hostname);
  }

  return lines
    .join('\n\n')
    .replace(/\n{2,}</g, '')
    .replace(/\s*<\s*$/g, '')
    .trim();
}

function cleanupNode($root: cheerio.Cheerio<any>) {
  REMOVE_SELECTORS.forEach((selector) => {
    $root.find(selector).remove();
  });
}

function getPreferredSelectors(url?: string): string[] {
  const hostname = getHostname(url);
  if (!hostname) return [];

  if (
    hostname.includes('chosun.com') ||
    hostname.includes('chosunbiz.com') ||
    hostname.includes('biz.chosun.com')
  ) {
    return [
      '[itemprop="articleBody"]',
      'article',
      'main',
      '.news_article',
      '.article-body',
      '.article__body',
      '.par',
    ];
  }

  if (hostname.includes('mt.co.kr') || hostname.includes('moneytoday.co.kr')) {
    return [
      '[itemprop="articleBody"]',
      'article',
      'main',
      '.article-body',
      '.article_content',
      '.news_body',
      '.view_cont',
      '.contents',
    ];
  }

  if (hostname.includes('sedaily.com')) {
    return ['#article_copy', '.article_view', '.article-body', '.news_cnt_detail_wrap'];
  }

  if (hostname.includes('asiae.co.kr')) {
    return ['.article_body', '.article-body', '#txt_area'];
  }

  if (hostname.includes('fnnews.com')) {
    return ['#article_content', '#articleBody', '.article_body', '.news_body', '.cont_view'];
  }

  return [];
}

function selectBestContentRoot($: cheerio.CheerioAPI, url?: string): cheerio.Cheerio<any> {
  let bestRoot: cheerio.Cheerio<any> = $('body');
  let bestScore = Number.NEGATIVE_INFINITY;
  const selectors = [...getPreferredSelectors(url), ...CONTENT_SELECTORS];
  const preferredSelectors = new Set(getPreferredSelectors(url));

  for (const selector of selectors) {
    if (typeof selector !== 'string') continue;
    $(selector).each((_, element) => {
      const candidate = $(element).clone();
      cleanupNode(candidate);
      const textLength = candidate.text().replace(/\s+/g, ' ').trim().length;
      const linkTextLength = candidate.find('a').text().replace(/\s+/g, ' ').trim().length;
      const paragraphCount = candidate.find('p, blockquote').length;
      const listCount = candidate.find('li').length;
      const anchorCount = candidate.find('a').length;
      const preferredBonus = preferredSelectors.has(selector) ? 200 : 0;
      const score =
        textLength +
        preferredBonus +
        (paragraphCount * 30) -
        (listCount * 8) -
        (anchorCount * 20) -
        Math.floor(linkTextLength * 0.35);

      if (score > bestScore) {
        bestScore = score;
        bestRoot = $(element);
      }
    });
  }

  return bestRoot;
}

function extractTextFromJsonLd(html: string): string {
  const $ = cheerio.load(html);
  const chunks: string[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).contents().text();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);
      const stack = Array.isArray(parsed) ? [...parsed] : [parsed];

      while (stack.length > 0) {
        const item = stack.pop();
        if (!item || typeof item !== 'object') continue;

        if (Array.isArray(item)) {
          stack.push(...item);
          continue;
        }

        const articleBody = typeof (item as Record<string, unknown>).articleBody === 'string'
          ? normalizeLine((item as Record<string, string>).articleBody)
          : '';
        if (articleBody.length >= 200) {
          chunks.push(articleBody);
        }

        Object.values(item as Record<string, unknown>).forEach((value) => {
          if (value && typeof value === 'object') {
            stack.push(value as Record<string, unknown>);
          }
        });
      }
    } catch {
      return;
    }
  });

  return chunks.join('\n\n').trim();
}

function extractTextFromFusionGlobalContent(html: string): string {
  const marker = 'Fusion.globalContent=';
  const start = html.indexOf(marker);
  if (start < 0) return '';

  const fromMarker = html.slice(start + marker.length);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIndex = -1;

  for (let index = 0; index < fromMarker.length; index += 1) {
    const char = fromMarker[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        endIndex = index + 1;
        break;
      }
    }
  }

  if (endIndex < 0) return '';

  const rawJson = fromMarker.slice(0, endIndex).trim();
  if (!rawJson.startsWith('{')) return '';

  try {
    const parsed = JSON.parse(rawJson) as {
      content_elements?: Array<{ type?: string; content?: string }>;
      description?: string;
    };

    const parts = Array.isArray(parsed.content_elements)
      ? parsed.content_elements
          .filter((item) => item && item.type === 'text' && typeof item.content === 'string')
          .map((item) => normalizeLine(item.content || ''))
          .filter((item) => item.length >= 20)
      : [];

    if (parts.length > 0) {
      return parts.join('\n\n').trim();
    }

    return typeof parsed.description === 'string' ? normalizeLine(parsed.description) : '';
  } catch {
    return '';
  }
}

function extractParagraphs($: cheerio.CheerioAPI, $root: cheerio.Cheerio<any>): string[] {
  const paragraphs: string[] = [];
  const blocks = $root.find('h1, h2, h3, p, li, blockquote');

  if (blocks.length > 0) {
    blocks.each((_, element) => {
      const text = normalizeLine($(element).text());
      if (text.length >= 20) {
        paragraphs.push(text);
      }
    });
  }

  if (paragraphs.length > 0) {
    return paragraphs;
  }

  const rawText = $root
    .text()
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  return rawText
    .split(/\n{1,2}/)
    .map(normalizeLine)
    .filter((line) => line.length >= 20);
}

function stripBoilerplate(lines: string[]): string[] {
  const cleaned: string[] = [];

  for (const line of lines) {
    const normalized = normalizeLine(line);
    if (!normalized) continue;
    if (normalized === '<' || normalized === '>') continue;
    if (NOISE_LINE_PATTERNS.some((pattern) => pattern.test(normalized))) {
      continue;
    }
    cleaned.push(normalized);
  }

  const joined = cleaned.join('\n\n');
  const cutoffIndex = CUTOFF_PATTERNS
    .map((pattern) => joined.search(pattern))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (typeof cutoffIndex === 'number' && cutoffIndex >= 0) {
    return joined
      .slice(0, cutoffIndex)
      .split(/\n{2,}/)
      .map(normalizeLine)
      .filter(Boolean);
  }

  return cleaned;
}

export function normalizeArticleText(text: string, url?: string): string {
  if (!text) return '';

  const lines = text
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split(/\n{1,2}/)
    .map(normalizeLine)
    .filter(Boolean);

  const normalized = stripBoilerplate(lines).join('\n\n').trim();
  return applySiteSpecificTextCleanup(normalized, url);
}

export function extractTextFromHtml(html: string, url?: string): string {
  if (!html) return '';

  const fusionText = normalizeArticleText(extractTextFromFusionGlobalContent(html), url);
  if (fusionText.length >= 200) {
    return fusionText;
  }

  const jsonLdText = normalizeArticleText(extractTextFromJsonLd(html), url);
  if (jsonLdText.length >= 500) {
    return jsonLdText;
  }

  const $ = cheerio.load(html);
  cleanupNode($.root());

  const bestRoot = selectBestContentRoot($, url).clone();
  cleanupNode(bestRoot);

  let paragraphs = stripBoilerplate(extractParagraphs($, bestRoot));

  if (paragraphs.join(' ').length < 300) {
    const bodyClone = $('body').clone();
    cleanupNode(bodyClone);
    paragraphs = stripBoilerplate(extractParagraphs($, bodyClone));
  }

  return paragraphs
    .join('\n\n')
    .replace(/\n{2,}<\s*$/g, '')
    .replace(/\s*<\s*$/g, '')
    .trim();
}

export function isContentSufficient(text: string, minLength: number = 100): boolean {
  if (!text || typeof text !== 'string') return false;
  return text.trim().length >= minLength;
}

export function cleanNoise(text: string): string {
  return normalizeArticleText(text);
}

export function isWithinDateRange(date: Date, hoursAgo: number = 24): boolean {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - hoursAgo);
  return date >= cutoff;
}

export function matchesKeywords(title: string, content: string, keywords?: string[]): boolean {
  if (!keywords || keywords.length === 0) return true;

  const searchText = `${title} ${content}`.toLowerCase();

  return keywords.some((keyword) => {
    const lowerKeyword = keyword.toLowerCase().trim();
    if (lowerKeyword.length === 0) return false;

    if (lowerKeyword.length <= 3 && /^[a-z0-9&]+$/i.test(lowerKeyword)) {
      const regex = new RegExp(`\\b${lowerKeyword}\\b`, 'i');
      return regex.test(searchText);
    }

    return searchText.includes(lowerKeyword);
  });
}

export function matchesAllKeywords(title: string, content: string, keywords?: string[]): boolean {
  if (!keywords || keywords.length === 0) return true;

  const searchText = `${title} ${content}`.toLowerCase();

  return keywords.every((keyword) => {
    const lowerKeyword = keyword.toLowerCase().trim();
    return lowerKeyword.length === 0 || searchText.includes(lowerKeyword);
  });
}

export function matchesNoneKeywords(title: string, content: string, keywords?: string[]): boolean {
  if (!keywords || keywords.length === 0) return true;

  const searchText = `${title} ${content}`.toLowerCase();

  return keywords.every((keyword) => {
    const lowerKeyword = keyword.toLowerCase().trim();
    return lowerKeyword.length === 0 || !searchText.includes(lowerKeyword);
  });
}

export function matchesSectors(title: string, content: string, sectors?: string[]): boolean {
  if (!sectors || sectors.length === 0) return true;
  return matchesKeywords(title, content, sectors);
}

export function matchesRuntimeFilters(
  title: string,
  content: string,
  options?: {
    anyKeywords?: string[];
    includeKeywords?: string[];
    mustIncludeKeywords?: string[];
    excludeKeywords?: string[];
    sectors?: string[];
  }
): boolean {
  if (!options) return true;

  return (
    matchesKeywords(title, content, options.anyKeywords) &&
    matchesKeywords(title, content, options.includeKeywords) &&
    matchesAllKeywords(title, content, options.mustIncludeKeywords) &&
    matchesNoneKeywords(title, content, options.excludeKeywords) &&
    matchesSectors(title, content, options.sectors)
  );
}
