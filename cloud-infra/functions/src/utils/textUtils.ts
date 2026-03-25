import * as cheerio from 'cheerio';

const CONTENT_SELECTORS = [
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

function cleanupNode($root: cheerio.Cheerio<any>) {
  REMOVE_SELECTORS.forEach((selector) => {
    $root.find(selector).remove();
  });
}

function selectBestContentRoot($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  let bestRoot: cheerio.Cheerio<any> = $('body');
  let bestScore = 0;

  for (const selector of CONTENT_SELECTORS) {
    if (typeof selector !== 'string') continue;
    $(selector).each((_, element) => {
      const candidate = $(element).clone();
      cleanupNode(candidate);
      const score = candidate.text().replace(/\s+/g, ' ').trim().length;
      if (score > bestScore) {
        bestScore = score;
        bestRoot = $(element);
      }
    });
  }

  return bestRoot;
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

export function normalizeArticleText(text: string): string {
  if (!text) return '';

  const lines = text
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split(/\n{1,2}/)
    .map(normalizeLine)
    .filter(Boolean);

  return stripBoilerplate(lines).join('\n\n').trim();
}

export function extractTextFromHtml(html: string): string {
  if (!html) return '';

  const $ = cheerio.load(html);
  cleanupNode($.root());

  const bestRoot = selectBestContentRoot($).clone();
  cleanupNode(bestRoot);

  let paragraphs = stripBoilerplate(extractParagraphs($, bestRoot));

  if (paragraphs.join(' ').length < 300) {
    const bodyClone = $('body').clone();
    cleanupNode(bodyClone);
    paragraphs = stripBoilerplate(extractParagraphs($, bodyClone));
  }

  return paragraphs.join('\n\n').trim();
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
