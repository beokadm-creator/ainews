import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as admin from 'firebase-admin';
import { isDuplicateArticle, hashUrl } from './duplicateService';
import { sendErrorNotificationToAdmin } from './telegramService';
import { isContentSufficient, cleanNoise, matchesRuntimeFilters } from '../utils/textUtils';
import { fixEncodingIssues } from '../utils/encodingUtils';
import { RuntimeFilters, RuntimeAiConfig } from '../types/runtime';
import { getDateRangeBounds } from './runtimeConfigService';

puppeteer.use(StealthPlugin());

interface ScrapedArticle {
  title: string;
  url: string;
  content: string;
  publishedAt: Date;
}

interface DynamicSourceConfig {
  selector?: string;
  listSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
  contentSelector?: string;
  dateSelector?: string;
  [key: string]: any;
}

async function getCookies(sourceId: string): Promise<any[]> {
  const db = admin.firestore();
  const sessionDoc = await db.collection('sessions').doc(sourceId).get();
  return sessionDoc.exists && sessionDoc.data()?.cookies ? sessionDoc.data()!.cookies : [];
}

const puppeteerScraperMap: Record<string, (page: any, baseUrl: string) => Promise<ScrapedArticle[]>> = {
  default: async (page: any, baseUrl: string) => {
    const articles: ScrapedArticle[] = [];
    await page.goto(baseUrl, { waitUntil: 'networkidle2' });

    const items = await page.$$('article, .article, .post, .news-item, .list-item');
    for (const item of items) {
      const titleEl = await item.$('h1 a, h2 a, h3 a, .title a, .link');
      if (!titleEl) continue;

      const title = await page.evaluate((el: any) => el.textContent.trim(), titleEl);
      const href = await page.evaluate((el: any) => el.getAttribute('href'), titleEl);
      const url = href?.startsWith('http') ? href : `${baseUrl}/${href}`;
      const contentEl = await item.$('p, .summary, .description, .excerpt');
      const content = contentEl ? await page.evaluate((el: any) => el.textContent.trim(), contentEl) : '';

      if (title && url) {
        articles.push({ title, url, content, publishedAt: new Date() });
      }
    }

    return articles;
  }
};

async function scrapePuppeteerDynamic(page: any, url: string, source: DynamicSourceConfig): Promise<ScrapedArticle[]> {
  const articles: ScrapedArticle[] = [];
  await page.goto(url, { waitUntil: 'networkidle2' });

  const listSelector = source.listSelector
    ? source.listSelector
    : (source.selector ? source.selector : 'article, .article, .post, .news-item, .list-item');

  const items = await page.$$(listSelector);
  for (const item of items) {
    const titleEl = source.titleSelector
      ? await item.$(source.titleSelector)
      : await item.$('h1 a, h2 a, h3 a, .title a, .link');

    if (!titleEl) continue;

    const title = await page.evaluate((el: any) => el.textContent.trim(), titleEl);
    let href = '';
    if (source.linkSelector) {
      const linkEl = await item.$(source.linkSelector);
      if (linkEl) {
        href = await page.evaluate((el: any) => el.getAttribute('href') || '', linkEl);
      }
    } else {
      href = await page.evaluate((el: any) => el.getAttribute('href'), titleEl);
    }

    const urlObj = new URL(url);
    const finalUrl = href?.startsWith('http')
      ? href
      : (href?.startsWith('/') ? `${urlObj.origin}${href}` : `${urlObj.origin}/${href}`);

    let content = '';
    const contentEl = source.contentSelector ? await item.$(source.contentSelector) : await item.$('p, .summary, .description, .excerpt');
    if (contentEl) {
      content = await page.evaluate((el: any) => el.textContent.trim(), contentEl);
    }

    let publishedAt = new Date();
    if (source.dateSelector) {
      const dateEl = await item.$(source.dateSelector);
      if (dateEl) {
        const dateText = await page.evaluate((el: any) => el.textContent.trim(), dateEl);
        const parsedDate = new Date(dateText);
        if (!isNaN(parsedDate.getTime())) publishedAt = parsedDate;
      }
    }

    if (title && finalUrl) {
      articles.push({
        title: fixEncodingIssues(title),
        url: finalUrl,
        content: fixEncodingIssues(content),
        publishedAt
      });
    }
  }

  return articles;
}

async function enrichArticles(page: any, articles: ScrapedArticle[]): Promise<ScrapedArticle[]> {
  return Promise.all(articles.map(async (article) => {
    if (isContentSufficient(article.content, 100)) return article;

    try {
      await page.goto(article.url, { waitUntil: 'networkidle2', timeout: 10000 });
      const pageContent = await page.evaluate(() => {
        const selectors = ['article', '.article-content', '.content', '.post-content', '#article-body', '#content', '.news-text', '.article-body', 'main'];
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element?.textContent && element.textContent.trim().length > 50) {
            return element.textContent;
          }
        }
        return document.body?.textContent || '';
      });

      if (pageContent) {
        const cleanedContent = cleanNoise(pageContent);
        if (isContentSufficient(cleanedContent, 50)) {
          return {
            ...article,
            content: cleanedContent.substring(0, 5000)
          };
        }
      }
    } catch (error) {
      console.warn(`Failed to fetch full article from ${article.url}:`, error);
    }

    return article;
  }));
}

export async function processPuppeteerSources(options?: {
  companyId?: string;
  pipelineRunId?: string;
  filters?: RuntimeFilters;
  aiConfig?: RuntimeAiConfig;
}) {
  const db = admin.firestore();
  const { startDate, endDate } = getDateRangeBounds(options?.filters?.dateRange);
  let browser: any = null;

  let sourcesQuery: FirebaseFirestore.Query = db.collection('sources')
    .where('type', '==', 'puppeteer')
    .where('active', '==', true);

  if (options?.companyId) {
    sourcesQuery = sourcesQuery.where('companyId', '==', options.companyId);
  }

  if (options?.filters?.sourceIds && options.filters.sourceIds.length > 0) {
    sourcesQuery = sourcesQuery.where(
      admin.firestore.FieldPath.documentId(),
      'in',
      options.filters.sourceIds.slice(0, 10)
    );
  }

  const sourcesSnapshot = await sourcesQuery.get();
  const allSourcesToProcess: { id: string; data: any; isGlobal: boolean }[] = [];
  sourcesSnapshot.docs.forEach(d => allSourcesToProcess.push({ id: d.id, data: d.data(), isGlobal: false }));

  // [ADD] GlobalSources 구독 처리
  const subscribedIds = options?.filters?.sourceIds ?? [];
  if (subscribedIds.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < subscribedIds.length; i += 30) chunks.push(subscribedIds.slice(i, i + 30));

    for (const chunk of chunks) {
      const globalSnap = await db.collection('globalSources')
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .where('type', '==', 'puppeteer')
        .where('status', '==', 'active')
        .get();
      globalSnap.docs.forEach(d => {
        if (!allSourcesToProcess.find(s => s.id === d.id)) {
          allSourcesToProcess.push({ id: d.id, data: d.data(), isGlobal: true });
        }
      });
    }
  }

  if (allSourcesToProcess.length === 0) {
    return { success: true, totalCollected: 0 };
  }

  let totalCollected = 0;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    for (const { id: sourceId, data: source, isGlobal } of allSourcesToProcess) {
      const docRef = isGlobal
        ? db.collection('globalSources').doc(sourceId)
        : db.collection('sources').doc(sourceId);
      const page = await browser.newPage();

      try {
        await page.setUserAgent('Mozilla/5.0');

        if (source.authType === 'session' || source.authType === 'puppeteer') {
          const cookies = await getCookies(sourceId);
          if (cookies.length > 0) {
            await page.setCookie(...cookies);
          }
        }

        const baseArticles = puppeteerScraperMap[sourceId]
          ? await puppeteerScraperMap[sourceId](page, source.url)
          : await scrapePuppeteerDynamic(page, source.url, source);
        const articles = await enrichArticles(page, baseArticles);

        let sourceCollected = 0;

        for (const article of articles) {
          if (startDate && article.publishedAt < startDate) continue;
          if (endDate && article.publishedAt > endDate) continue;

          const anyKeywords = [
            ...(source.keywords || []),
            ...(options?.filters?.keywords || [])
          ];

          if (!matchesRuntimeFilters(article.title, article.content, {
            anyKeywords,
            includeKeywords: options?.filters?.includeKeywords,
            excludeKeywords: options?.filters?.excludeKeywords,
            sectors: options?.filters?.sectors
          })) {
            continue;
          }

          const dupCheck = await isDuplicateArticle(article, {
            companyId: source.companyId || options?.companyId,
            aiConfig: options?.aiConfig
          });
          if (dupCheck.isDuplicate) continue;

          const articleRef = db.collection('articles').doc();
          await articleRef.set({
            id: articleRef.id,
            ...article,
            companyId: source.companyId || options?.companyId || null,
            pipelineRunId: options?.pipelineRunId || null,
            source: source.name,
            sourceId,
            globalSourceId: isGlobal ? sourceId : null,
            collectedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'pending',
            urlHash: hashUrl(article.url)
          });

          sourceCollected++;
          totalCollected++;
        }

        if (source.authType === 'session' || source.authType === 'puppeteer') {
          const currentCookies = await page.cookies();
          await db.collection('sessions').doc(sourceId).set({
            cookies: currentCookies,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
  
        await docRef.update({
          lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastStatus: 'success',
          errorMessage: null
        });
  
        console.log(`Processed ${sourceCollected} puppeteer articles from ${source.name}${isGlobal ? ' [global]' : ''}`);
      } catch (error: any) {
        await docRef.update({
          lastStatus: 'error',
          errorMessage: error.message
        }).catch(() => {});
        await sendErrorNotificationToAdmin('Puppeteer collection failed', error.message, source.name);
      } finally {
        await page.close();
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return { success: true, totalCollected };
}

/**
 * MarketInsight 유료 회원 로그인
 * 환경변수: MARKETINSIGHT_EMAIL, MARKETINSIGHT_PASSWORD
 */
export async function loginMarketInsight(): Promise<{ success: boolean; cookies?: any[]; message: string }> {
  const email = process.env.MARKETINSIGHT_EMAIL;
  const password = process.env.MARKETINSIGHT_PASSWORD;

  if (!email || !password) {
    return { success: false, message: 'MarketInsight credentials not configured' };
  }

  let browser: any = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    // 1. 메인 페이지 로드
    console.log('[MarketInsight] Loading main page...');
    await page.goto('https://marketinsight.hankyung.com', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // 2. 로그인 폼 찾기 및 입력
    console.log('[MarketInsight] Logging in...');
    const emailInput = await page.$('input[type="email"], input[name*="email"], input[name*="id"]');
    const passwordInput = await page.$('input[type="password"], input[name*="password"]');

    if (!emailInput || !passwordInput) {
      return { success: false, message: 'Login form not found' };
    }

    await emailInput.type(email);
    await passwordInput.type(password);

    // 로그인 버튼 찾아서 클릭
    const loginButton = await page.$('button[type="submit"], button[class*="login"]');
    if (loginButton) {
      await loginButton.click();
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    }

    // 3. 로그인 성공 확인 (URL 변경 또는 특정 요소 존재)
    const currentUrl = page.url();
    const isLoggedIn = !currentUrl.includes('login') && !currentUrl.includes('sign');

    if (!isLoggedIn) {
      return { success: false, message: 'Login failed' };
    }

    // 4. 쿠키 추출
    const cookies = await page.cookies();

    // 5. Firestore에 세션 저장
    const db = admin.firestore();
    await db.collection('sessions').doc('marketinsight_mna').set({
      cookies,
      email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24시간
    });

    console.log('[MarketInsight] Login successful, cookies saved');
    return { success: true, cookies, message: 'Logged in successfully' };

  } catch (err: any) {
    console.error('[MarketInsight] Login error:', err.message);
    return { success: false, message: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * MarketInsight MNA 섹션 스크래핑 (유료 회원)
 */
export async function scrapeMarketInsightMNA(): Promise<ScrapedArticle[]> {
  const db = admin.firestore();
  const sessionDoc = await db.collection('sessions').doc('marketinsight_mna').get();

  if (!sessionDoc.exists) {
    console.error('[MarketInsight] No session found. Please login first.');
    return [];
  }

  const sessionData = sessionDoc.data();
  const cookies = sessionData?.cookies || [];
  let browser: any = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    // 쿠키 설정
    if (cookies.length > 0) {
      await page.setCookie(...cookies);
    }

    // MNA 섹션 접근
    console.log('[MarketInsight] Loading MNA section...');
    await page.goto('https://marketinsight.hankyung.com/mna', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // 기사 목록 스크래핑
    const articles: ScrapedArticle[] = await page.evaluate(() => {
      const items: any[] = [];

      // 다양한 선택자 시도
      const selectors = [
        '.article-item',
        '.news-item',
        '.post-item',
        '[class*="article"]',
        'article',
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          elements.forEach((el) => {
            const titleEl = el.querySelector('h1, h2, h3, .title, a');
            const linkEl = el.querySelector('a[href]');
            const contentEl = el.querySelector('p, .summary, .description');
            const dateEl = el.querySelector('time, .date, [class*="date"]');

            if (titleEl && linkEl) {
              items.push({
                title: titleEl.textContent?.trim() || '',
                url: linkEl.getAttribute('href') || '',
                content: contentEl?.textContent?.trim() || '',
                publishedAt: new Date(dateEl?.getAttribute('datetime') || dateEl?.textContent || Date.now())
              });
            }
          });

          if (items.length > 0) break;
        }
      }

      return items;
    });

    // URL 정규화
    const baseUrl = 'https://marketinsight.hankyung.com';
    const normalizedArticles = articles
      .filter((a) => a.title && a.url)
      .map((a) => ({
        ...a,
        url: a.url.startsWith('http') ? a.url : `${baseUrl}${a.url.startsWith('/') ? '' : '/'}${a.url}`
      }));

    console.log(`[MarketInsight] Scraped ${normalizedArticles.length} articles`);
    return normalizedArticles;

  } catch (err: any) {
    console.error('[MarketInsight] Scraping error:', err.message);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}
