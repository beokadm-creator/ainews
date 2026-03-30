import axios from 'axios';
import { decodeBuffer, cleanHtmlContent } from '../utils/encodingUtils';
import { extractTextFromHtml, normalizeArticleText } from '../utils/textUtils';

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (compatible; NewsBot/1.0; +https://eumnews.com)';
const MIN_BODY_LENGTH = 500;
const MAX_BODY_CHARS = 12000;
const FORCE_FETCH_HOSTS = [
  'www.fnnews.com',
  'fnnews.com',
  'www.sedaily.com',
  'sedaily.com',
  'www.asiae.co.kr',
  'asiae.co.kr',
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
  const extracted = extractTextFromHtml(html);
  const cleaned = normalizeArticleText(cleanHtmlContent(extracted), url);
  return cleaned.slice(0, MAX_BODY_CHARS);
}

export async function enrichArticleBody<T extends { url: string; content?: string | null }>(article: T): Promise<T> {
  const currentContent = normalizeArticleText(cleanHtmlContent(article.content || ''), article.url);
  const forceFetch = shouldForceFetch(article.url);

  if (!forceFetch && isLikelyFullArticleBody(currentContent)) {
    return {
      ...article,
      content: currentContent,
    };
  }

  try {
    const fetched = await fetchArticleBodyByUrl(article.url);
    if (isLikelyFullArticleBody(fetched)) {
      return {
        ...article,
        content: fetched,
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
