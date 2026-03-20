import * as cheerio from 'cheerio';

/**
 * HTML에서 텍스트를 추출하고 정규화합니다.
 * - HTML 태그 제거
 * - 연속 공백/줄바꿈 정리
 * - 불필요한 공백 제거
 */
export function extractTextFromHtml(html: string): string {
  if (!html) return '';
  
  // Cheerio로 HTML 파싱
  const $ = cheerio.load(html);
  
  // script, style, nav, footer 제거
  $('script, style, nav, footer, aside, .ad, .advertisement').remove();
  
  // 본문 영역 추출 (일반적인 본문 선택자)
  const contentSelectors = [
    'article',
    '.article-content',
    '.content',
    '.post-content',
    '#article-body',
    '#content',
    '.news-text',
    '.article-body',
    'main'
  ];
  
  let text = '';
  for (const selector of contentSelectors) {
    const element = $(selector);
    if (element.length > 0) {
      text = element.text();
      break;
    }
  }
  
  // 본문 영역을 찾지 못하면 body 전체에서 텍스트 추출
  if (!text || text.trim().length < 50) {
    text = $('body').text();
  }
  
  // 텍스트 정규화
  text = text
    .replace(/\s+/g, ' ')  // 연속 공백을 하나로
    .replace(/\n\s*\n/g, '\n')  // 연속 줄바꿈 정리
    .trim();
  
  return text;
}

/**
 * 텍스트가 충분한 내용을 포함하는지 확인합니다.
 * @param text - 검증할 텍스트
 * @param minLength - 최소 길이 (기본 100자)
 */
export function isContentSufficient(text: string, minLength: number = 100): boolean {
  if (!text || typeof text !== 'string') return false;
  return text.trim().length >= minLength;
}

/**
 * 불필요한 문자열을 제거합니다 (광고, 저작권 표시 등)
 */
export function cleanNoise(text: string): string {
  if (!text) return '';
  
  const noisePatterns = [
    /ⓒ.*?무단전재 및 재배포 금지/g,
    /저작권자.*?All rights reserved/gi,
    /Advertisement.*?$/gi,
    /본 콘텐츠는.*?금지입니다/g,
  ];
  
  let cleaned = text;
  for (const pattern of noisePatterns) {
    cleaned = cleaned.replace(pattern, '');
  }
  
  return cleaned.trim();
}

/**
 * 날짜가 지정된 범위 내에 있는지 확인합니다.
 * @param date - 확인할 날짜
 * @param hoursAgo - 몇 시간 전까지 허용할지 (기본 24시간)
 * @returns true이면 범위 내
 */
export function isWithinDateRange(date: Date, hoursAgo: number = 24): boolean {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - hoursAgo);
  return date >= cutoff;
}

/**
 * 기사 제목과 내용이 키워드를 포함하는지 확인합니다.
 * 키워드 배열이 비어있으면 항상 true를 반환합니다 (필터링 없음).
 * @param title - 기사 제목
 * @param content - 기사 내용
 * @param keywords - 필터링할 키워드 배열
 * @returns true면 키워드 조건 통과, false면 필터링 대상
 */
export function matchesKeywords(title: string, content: string, keywords?: string[]): boolean {
  if (!keywords || keywords.length === 0) return true;
  
  const searchText = `${title} ${content}`.toLowerCase();
  
  return keywords.some(keyword => {
    const lowerKeyword = keyword.toLowerCase().trim();
    if (lowerKeyword.length === 0) return false;

    // 만약 키워드가 매우 짧거나(예: "AI", "PE") 영문만 포함된 경우, 
    // 정규표현식을 사용하여 부분 일치가 아닌 단어 단위 일치 확인 (간단한 워드 바운더리 체크)
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

  return keywords.every(keyword => {
    const lowerKeyword = keyword.toLowerCase().trim();
    return lowerKeyword.length === 0 || searchText.includes(lowerKeyword);
  });
}

export function matchesNoneKeywords(title: string, content: string, keywords?: string[]): boolean {
  if (!keywords || keywords.length === 0) return true;

  const searchText = `${title} ${content}`.toLowerCase();

  return keywords.every(keyword => {
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
    excludeKeywords?: string[];
    sectors?: string[];
  }
): boolean {
  if (!options) return true;

  return (
    matchesKeywords(title, content, options.anyKeywords) &&
    matchesAllKeywords(title, content, options.includeKeywords) &&
    matchesNoneKeywords(title, content, options.excludeKeywords) &&
    matchesSectors(title, content, options.sectors)
  );
}
