import axios from 'axios';
import { decodeBuffer, cleanHtmlContent } from '../utils/encodingUtils';
import { extractTextFromHtml, normalizeArticleText } from '../utils/textUtils';

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (compatible; NewsBot/1.0; +https://eumnews.com)';
const MIN_BODY_LENGTH = 500;
const FETCH_RETRY_CONTENT_LENGTH = 1400;
const MAX_BODY_CHARS = 50000;
const FORCE_FETCH_HOSTS = [
  'www.fnnews.com',
  'fnnews.com',
  'www.sedaily.com',
  'sedaily.com',
  'www.asiae.co.kr',
  'asiae.co.kr',
  'www.mt.co.kr',
  'mt.co.kr',
  'www.edaily.co.kr',
  'edaily.co.kr',
  'www.yna.co.kr',
  'yna.co.kr',
  'www.chosun.com',
  'chosun.com',
  'biz.chosun.com',
  'www.chosunbiz.com',
  'chosunbiz.com',
];

function getHostname(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function shouldForceFetch(url?: string): boolean {
  const hostname = getHostname(url);
  return FORCE_FETCH_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

export function isLikelyFullArticleBody(content?: string | null) {
  const normalized = `${content || ''}`.replace(/\s+/g, ' ').trim();
  return normalized.length >= MIN_BODY_LENGTH;
}

function looksLikeSummary(content?: string | null) {
  const normalized = `${content || ''}`.trim();
  if (!normalized) return true;

  const paragraphs = normalized.split(/\n{2,}/).filter(Boolean);
  if (normalized.length < 900) return true;
  if (normalized.length < FETCH_RETRY_CONTENT_LENGTH && paragraphs.length <= 3) return true;
  if (paragraphs.length <= 1 && normalized.length < 1800) return true;

  return false;
}

function shouldFetchBody(url: string, currentContent: string) {
  if (shouldForceFetch(url)) return true;
  if (!isLikelyFullArticleBody(currentContent)) return true;
  return looksLikeSummary(currentContent);
}

function selectPreferredBody(currentContent: string, fetchedContent: string) {
  if (!fetchedContent) return currentContent;
  if (!currentContent) return fetchedContent;

  if (!isLikelyFullArticleBody(currentContent) && fetchedContent.length > currentContent.length) {
    return fetchedContent;
  }

  if (isLikelyFullArticleBody(fetchedContent) && fetchedContent.length >= currentContent.length) {
    return fetchedContent;
  }

  return currentContent;
}

export async function fetchArticleBodyByUrl(url: string): Promise<string> {
  if (!url) return '';

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  const html = decodeBuffer(Buffer.from(response.data), undefined, response.headers['content-type'] || '');
  const extracted = extractTextFromHtml(html, url);
  const cleaned = normalizeArticleText(cleanHtmlContent(extracted), url);
  return cleaned.slice(0, MAX_BODY_CHARS);
}

export async function enrichArticleBody<T extends { url: string; content?: string | null }>(article: T): Promise<T> {
  const currentContent = normalizeArticleText(cleanHtmlContent(article.content || ''), article.url);

  if (!shouldFetchBody(article.url, currentContent)) {
    return {
      ...article,
      content: currentContent,
    };
  }

  try {
    const fetched = await fetchArticleBodyByUrl(article.url);
    const preferredContent = selectPreferredBody(currentContent, fetched);
    if (preferredContent) {
      return {
        ...article,
        content: preferredContent,
      };
    }
  } catch (error: any) {
    console.warn(`[ArticleBodyFetch] Failed to fetch article body for ${article.url}: ${error.message}`);
  }

  return {
    ...article,
    content: currentContent,
  };
}
