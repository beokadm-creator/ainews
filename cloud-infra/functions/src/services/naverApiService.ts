import axios from 'axios';
import * as dns from 'dns';
import https from 'https';

const NAVER_NEWS_ENDPOINT = 'https://openapi.naver.com/v1/search/news.json';
const NAVER_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  family: 4,
  lookup: (hostname, options, callback) => dns.lookup(hostname, { ...options, family: 4, all: false }, callback),
});

interface FetchNaverNewsOptions {
  clientId: string;
  clientSecret: string;
  query: string;
  display?: number;
  start?: number;
  sort?: 'date' | 'sim';
  timeoutMs?: number;
}

function shouldRetry(error: any) {
  const status = error?.response?.status;
  const code = `${error?.code || ''}`.toUpperCase();
  const message = `${error?.message || ''}`.toUpperCase();

  return (
    status === 429 ||
    (typeof status === 'number' && status >= 500) ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    message.includes('DEADLINE_EXCEEDED') ||
    message.includes('TIMEOUT')
  );
}

export async function fetchNaverNews(options: FetchNaverNewsOptions) {
  const attempts = [
    { timeoutMs: options.timeoutMs ?? 5000, httpsAgent: NAVER_HTTPS_AGENT as https.Agent | undefined },
    { timeoutMs: 7000, httpsAgent: NAVER_HTTPS_AGENT as https.Agent | undefined },
    { timeoutMs: 9000, httpsAgent: undefined },
  ];

  let lastError: any;

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    try {
      return await axios.get(NAVER_NEWS_ENDPOINT, {
        headers: {
          'X-Naver-Client-Id': options.clientId,
          'X-Naver-Client-Secret': options.clientSecret,
        },
        params: {
          query: options.query,
          display: options.display ?? 100,
          start: options.start ?? 1,
          sort: options.sort ?? 'date',
        },
        timeout: attempt.timeoutMs,
        httpsAgent: attempt.httpsAgent,
      });
    } catch (error: any) {
      lastError = error;
      if (!shouldRetry(error) || i === attempts.length - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
    }
  }

  throw lastError;
}
