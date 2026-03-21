import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import chromium from '@sparticuz/chromium';
import * as admin from 'firebase-admin';
import { isDuplicateArticle, hashUrl } from './duplicateService';
import { sendErrorNotificationToAdmin } from './telegramService';
import { isContentSufficient, cleanNoise, matchesRuntimeFilters } from '../utils/textUtils';
import { fixEncodingIssues } from '../utils/encodingUtils';
import { RuntimeFilters, RuntimeAiConfig } from '../types/runtime';
import { getDateRangeBounds } from './runtimeConfigService';

puppeteer.use(StealthPlugin());

/** Cloud Functions(서버리스) 환경에 맞는 브라우저 launch 옵션 */
async function getLaunchOptions() {
  const executablePath = await chromium.executablePath();
  return {
    executablePath,
    headless: true,
    args: [
      ...chromium.args,
      '--disable-blink-features=AutomationControlled',
    ],
  };
}

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
      ...(await getLaunchOptions())
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
 * MarketInsight 유료 회원 로그인 (세션 유지)
 * 환경변수: MARKETINSIGHT_EMAIL, MARKETINSIGHT_PASSWORD
 *
 * 동작:
 * 1. 기존 유효한 세션이 있으면 재사용
 * 2. 세션이 없거나 만료되면 새로 로그인
 * 3. 로그인 후 쿠키를 Firestore에 저장하고 7일간 유지
 */
export async function loginMarketInsight(): Promise<{ success: boolean; cookies?: any[]; message: string }> {
  const email = process.env.MARKETINSIGHT_EMAIL || '';
  const password = process.env.MARKETINSIGHT_PASSWORD || '';

  if (!email || !password) {
    console.error('[MarketInsight] Credentials not configured (MARKETINSIGHT_EMAIL, MARKETINSIGHT_PASSWORD)');
    return { success: false, message: 'MarketInsight credentials not configured' };
  }

  const db = admin.firestore();
  const sessionRef = db.collection('sessions').doc('marketinsight_mna');

  // 1. 기존 유효한 세션 확인
  const existingSession = await sessionRef.get();
  if (existingSession.exists) {
    const sessionData = existingSession.data();
    const expiresAt = sessionData?.expiresAt?.toDate?.() || new Date(sessionData?.expiresAt);

    if (expiresAt > new Date()) {
      console.log('[MarketInsight] Using existing valid session');
      return {
        success: true,
        cookies: sessionData?.cookies || [],
        message: 'Using existing session'
      };
    }
  }

  // 2. 새로운 로그인 필요
  let browser: any = null;

  try {
    console.log('[MarketInsight] Starting new login...');
    browser = await puppeteer.launch({
      ...(await getLaunchOptions()),
      timeout: 60000
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    // User-Agent 설정 (봇 탐지 회피)
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // 1. 메인 페이지 로드
    console.log('[MarketInsight] Loading login page...');
    await page.goto('https://marketinsight.hankyung.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // 2. 로그인 폼 입력
    console.log('[MarketInsight] Filling login form...');

    // 이메일/아이디 입력 필드 찾기
    const emailInput = await page.$eval(
      'input[type="text"], input[type="email"], input[name="id"], input[name="email"], input[name="uid"]',
      (el: any) => el
    ).catch(() => null);

    // 비밀번호 입력 필드 찾기
    const passwordInput = await page.$eval(
      'input[type="password"]',
      (el: any) => el
    ).catch(() => null);

    if (!emailInput || !passwordInput) {
      console.error('[MarketInsight] Login form fields not found');
      return { success: false, message: 'Login form not found on page' };
    }

    // 입력값 설정
    await page.evaluate((email: string) => {
      const input = document.querySelector('input[type="text"], input[type="email"], input[name="id"], input[name="email"], input[name="uid"]') as HTMLInputElement;
      if (input) input.value = email;
    }, email);

    await page.evaluate((pwd: string) => {
      const input = document.querySelector('input[type="password"]') as HTMLInputElement;
      if (input) input.value = pwd;
    }, password);

    // 3. 로그인 버튼 클릭
    console.log('[MarketInsight] Clicking login button...');
    const loginButton = await page.$('button[type="submit"], button[onclick*="login"], input[type="submit"], .btn-login');

    if (!loginButton) {
      console.error('[MarketInsight] Login button not found');
      return { success: false, message: 'Login button not found' };
    }

    await Promise.all([
      loginButton.click(),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null)
    ]);

    // 추가 대기 (비동기 리다이렉트 처리)
    await page.waitForTimeout(2000);

    // 4. 로그인 성공 확인
    const currentUrl = page.url();
    const pageContent = await page.content();

    // 로그인 실패 페이지 감지
    const isLoginPage = currentUrl.includes('login') || currentUrl.includes('sign');
    const hasErrorMessage = pageContent.includes('실패') || pageContent.includes('오류') || pageContent.includes('실패');

    if (isLoginPage || hasErrorMessage) {
      console.error('[MarketInsight] Login failed - still on login page or error detected');
      return { success: false, message: 'Login failed - check credentials' };
    }

    // 5. MNA 페이지 접근 확인
    console.log('[MarketInsight] Verifying access to MNA section...');
    await page.goto('https://marketinsight.hankyung.com/mna', {
      waitUntil: 'networkidle2',
      timeout: 30000
    }).catch((err: any) => {
      console.warn('[MarketInsight] Warning accessing MNA:', err.message);
    });

    // 6. 쿠키 추출
    const cookies = await page.cookies();

    if (!cookies || cookies.length === 0) {
      console.warn('[MarketInsight] No cookies found');
      return { success: false, message: 'Session cookies not found' };
    }

    // 7. Firestore에 세션 저장 (7일 유효기간)
    const expirationTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await sessionRef.set({
      cookies,
      email,
      loginAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: expirationTime,
      status: 'active'
    });

    console.log('[MarketInsight] Login successful, session saved for 7 days');
    return {
      success: true,
      cookies,
      message: 'Logged in successfully'
    };

  } catch (err: any) {
    console.error('[MarketInsight] Login error:', err.message, err.stack);
    return { success: false, message: `Login failed: ${err.message}` };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.warn('[MarketInsight] Browser close error:', e);
      }
    }
  }
}

/**
 * MarketInsight MNA 섹션 스크래핑 (유료 회원)
 *
 * 동작:
 * 1. 기존 유효한 세션이 있으면 사용
 * 2. 세션이 없거나 만료되었으면 자동으로 로그인
 * 3. 쿠키로 MNA 페이지에 접근하여 기사 스크래핑
 */
export async function scrapeMarketInsightMNA(): Promise<ScrapedArticle[]> {
  const db = admin.firestore();
  const sessionRef = db.collection('sessions').doc('marketinsight_mna');

  // 1. 세션 확인 및 필요시 재로그인
  let sessionData = (await sessionRef.get()).data();

  // 세션이 없거나 만료된 경우 로그인
  if (!sessionData) {
    console.log('[MarketInsight] No session found, logging in...');
    const loginResult = await loginMarketInsight();
    if (!loginResult.success) {
      console.error('[MarketInsight] Login failed, cannot scrape');
      return [];
    }
    sessionData = (await sessionRef.get()).data();
  } else {
    const expiresAt = sessionData.expiresAt?.toDate?.() || new Date(sessionData.expiresAt);
    if (expiresAt <= new Date()) {
      console.log('[MarketInsight] Session expired, logging in again...');
      const loginResult = await loginMarketInsight();
      if (!loginResult.success) {
        console.error('[MarketInsight] Re-login failed, cannot scrape');
        return [];
      }
      sessionData = (await sessionRef.get()).data();
    }
  }

  const cookies = sessionData?.cookies || [];

  if (!cookies || cookies.length === 0) {
    console.error('[MarketInsight] No valid cookies available');
    return [];
  }

  let browser: any = null;

  try {
    console.log('[MarketInsight] Starting scrape with session');
    browser = await puppeteer.launch({
      ...(await getLaunchOptions()),
      timeout: 60000
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    // User-Agent 설정
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // 쿠키 설정
    try {
      await page.setCookie(...cookies);
      console.log(`[MarketInsight] Set ${cookies.length} cookies`);
    } catch (err: any) {
      console.warn('[MarketInsight] Cookie setting warning:', err.message);
    }

    // MNA 섹션 접근
    console.log('[MarketInsight] Loading MNA section...');
    const response = await page.goto('https://marketinsight.hankyung.com/mna', {
      waitUntil: 'networkidle2',
      timeout: 30000
    }).catch((err: any) => {
      console.warn('[MarketInsight] Navigation error:', err.message);
      return null;
    });

    if (!response) {
      console.error('[MarketInsight] Failed to load MNA page');
      return [];
    }

    const statusCode = response.status();
    if (statusCode === 401 || statusCode === 403) {
      console.log('[MarketInsight] Access denied (401/403), session likely expired');
      await sessionRef.update({ status: 'expired' });
      return [];
    }

    // 기사 목록 스크래핑
    console.log('[MarketInsight] Scraping articles...');
    const articles: ScrapedArticle[] = await page.evaluate(() => {
      const items: any[] = [];

      // MNA 섹션 특화 선택자들
      const selectors = [
        'div[class*="mna"], div[class*="MNA"]',
        '.article-list li, .article-list article',
        '.news-list li, .news-list article',
        'tr[class*="row"]', // 테이블 기반 레이아웃
        '.list-item',
        'article',
        '.post-item'
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          console.log(`Found ${elements.length} items with selector: ${selector}`);

          elements.forEach((el) => {
            const titleEl = el.querySelector('h2, h3, h4, .title, a, strong');
            const linkEl = el.querySelector('a[href*="/"]');
            const contentEl = el.querySelector('p, .summary, .description, td');
            const dateEl = el.querySelector('time, .date, [class*="date"], span[class*="date"]');

            if (titleEl && linkEl) {
              const title = titleEl.textContent?.trim() || '';
              const url = linkEl.getAttribute('href') || '';
              const content = contentEl?.textContent?.trim() || '';
              const dateStr = dateEl?.getAttribute('datetime') || dateEl?.textContent;

              if (title && url && title.length > 3) {
                items.push({
                  title,
                  url,
                  content: content.substring(0, 500),
                  publishedAt: dateStr ? new Date(dateStr) : new Date()
                });
              }
            }
          });

          if (items.length > 0) break;
        }
      }

      return items.slice(0, 100); // 최대 100개
    });

    // URL 정규화
    const baseUrl = 'https://marketinsight.hankyung.com';
    const normalizedArticles = articles
      .filter((a) => a.title && a.url && a.title.length > 3)
      .map((a) => ({
        ...a,
        url: a.url.startsWith('http')
          ? a.url
          : `${baseUrl}${a.url.startsWith('/') ? '' : '/'}${a.url}`,
        content: a.content.substring(0, 1000)
      }));

    console.log(`[MarketInsight] Successfully scraped ${normalizedArticles.length} articles`);

    // 마지막 스크래핑 시간 업데이트
    await sessionRef.update({
      lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastArticleCount: normalizedArticles.length
    });

    return normalizedArticles;

  } catch (err: any) {
    console.error('[MarketInsight] Scraping error:', err.message, err.stack);
    return [];
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.warn('[MarketInsight] Browser close error:', e);
      }
    }
  }
}

// ─────────────────────────────────────────
// Thebell 유료 회원 로그인 & 스크래핑
// ─────────────────────────────────────────

/**
 * Thebell 유료 회원 로그인 (세션 유지)
 * 환경변수: THEBELL_EMAIL, THEBELL_PASSWORD
 *
 * 동작:
 * 1. 기존 유효한 세션이 있으면 재사용
 * 2. 세션이 없거나 만료되면 새로 로그인
 * 3. 로그인 후 쿠키를 Firestore에 저장하고 7일간 유지
 *
 * 참고: Thebell은 PC 인증(쿠키/세션 기반)을 사용하므로
 *       최초 로그인 후 세션 쿠키를 저장해 재사용합니다.
 */
export async function loginThebell(): Promise<{ success: boolean; cookies?: any[]; message: string }> {
  const email = process.env.THEBELL_EMAIL || '';
  const password = process.env.THEBELL_PASSWORD || '';

  if (!email || !password) {
    console.error('[Thebell] Credentials not configured (THEBELL_EMAIL, THEBELL_PASSWORD)');
    return { success: false, message: 'Thebell credentials not configured' };
  }

  const db = admin.firestore();
  const sessionRef = db.collection('sessions').doc('thebell');

  // 1. 기존 유효한 세션 확인
  const existingSession = await sessionRef.get();
  if (existingSession.exists) {
    const sessionData = existingSession.data();
    const expiresAt = sessionData?.expiresAt?.toDate?.() || new Date(sessionData?.expiresAt);
    if (expiresAt > new Date()) {
      console.log('[Thebell] Using existing valid session');
      return { success: true, cookies: sessionData?.cookies || [], message: 'Using existing session' };
    }
  }

  let browser: any = null;

  try {
    console.log('[Thebell] Starting new login...');
    browser = await puppeteer.launch({
      ...(await getLaunchOptions()),
      timeout: 60000
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('[Thebell] Loading login page...');
    await page.goto('https://www.thebell.co.kr/front/index.asp', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // 로그인 폼 입력
    console.log('[Thebell] Filling login form...');
    await page.evaluate((id: string, pw: string) => {
      const idInput = document.querySelector('input[name="user_id"], input[id="user_id"], input[name="id"], input[type="text"]') as HTMLInputElement;
      const pwInput = document.querySelector('input[name="user_pw"], input[id="user_pw"], input[name="password"], input[type="password"]') as HTMLInputElement;
      if (idInput) idInput.value = id;
      if (pwInput) pwInput.value = pw;
    }, email, password);

    // 로그인 버튼 클릭
    const loginButton = await page.$('input[type="submit"], button[type="submit"], .btn_login, a[href*="login"]');
    if (!loginButton) {
      console.error('[Thebell] Login button not found');
      return { success: false, message: 'Login button not found' };
    }

    await Promise.all([
      loginButton.click(),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null)
    ]);

    await page.waitForTimeout(2000);

    // 로그인 성공 확인
    const currentUrl = page.url();
    const pageContent = await page.content();
    const isLoginPage = currentUrl.includes('login') || pageContent.includes('로그인');
    const hasError = pageContent.includes('아이디') && pageContent.includes('비밀번호') && pageContent.includes('틀');

    if (hasError) {
      console.error('[Thebell] Login failed - wrong credentials');
      return { success: false, message: 'Login failed - check credentials' };
    }

    const cookies = await page.cookies();
    if (!cookies || cookies.length === 0) {
      return { success: false, message: 'No session cookies found' };
    }

    // 세션 저장 (7일)
    const expirationTime = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await sessionRef.set({
      cookies,
      email,
      loginAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: expirationTime,
      status: 'active',
      loginUrl: currentUrl
    });

    console.log('[Thebell] Login successful, session saved for 7 days');
    return { success: true, cookies, message: isLoginPage ? 'Logged in (session may need verification)' : 'Logged in successfully' };

  } catch (err: any) {
    console.error('[Thebell] Login error:', err.message, err.stack);
    return { success: false, message: `Login failed: ${err.message}` };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
  }
}

/**
 * Thebell 최신 기사 스크래핑
 * 세션이 없거나 만료되면 자동으로 로그인
 */
export async function scrapeThebell(): Promise<ScrapedArticle[]> {
  const db = admin.firestore();
  const sessionRef = db.collection('sessions').doc('thebell');

  // 세션 확인 및 필요시 재로그인
  let sessionData = (await sessionRef.get()).data();

  if (!sessionData) {
    console.log('[Thebell] No session found, logging in...');
    const loginResult = await loginThebell();
    if (!loginResult.success) {
      console.error('[Thebell] Login failed, cannot scrape');
      return [];
    }
    sessionData = (await sessionRef.get()).data();
  } else {
    const expiresAt = sessionData.expiresAt?.toDate?.() || new Date(sessionData.expiresAt);
    if (expiresAt <= new Date()) {
      console.log('[Thebell] Session expired, logging in again...');
      const loginResult = await loginThebell();
      if (!loginResult.success) {
        console.error('[Thebell] Re-login failed');
        return [];
      }
      sessionData = (await sessionRef.get()).data();
    }
  }

  const cookies = sessionData?.cookies || [];
  let browser: any = null;

  try {
    browser = await puppeteer.launch({
      ...(await getLaunchOptions()),
      timeout: 60000
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    if (cookies.length > 0) {
      try {
        await page.setCookie(...cookies);
      } catch (e: any) {
        console.warn('[Thebell] Cookie warning:', e.message);
      }
    }

    // 최신 기사 목록 페이지 접근
    console.log('[Thebell] Loading article list...');
    const response = await page.goto('https://www.thebell.co.kr/front/free/contents/News/list.asp', {
      waitUntil: 'networkidle2',
      timeout: 30000
    }).catch((err: any) => {
      console.warn('[Thebell] Navigation warning:', err.message);
      return null;
    });

    if (!response) return [];

    // 기사 스크래핑
    const articles: ScrapedArticle[] = await page.evaluate(() => {
      const items: any[] = [];

      const selectors = [
        '.news_list li, .news_list article',
        'table.list tbody tr',
        '.article-list li',
        '.content-list li',
        'ul.list li'
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          elements.forEach((el) => {
            const titleEl = el.querySelector('a.tit, .title a, h3 a, h4 a, td.tit a, a[href*="article"]');
            const dateEl = el.querySelector('.date, span.date, td.date, time');
            const contentEl = el.querySelector('.lead, .summary, td.lead, p');

            if (titleEl) {
              const href = (titleEl as HTMLAnchorElement).getAttribute('href') || '';
              const title = titleEl.textContent?.trim() || '';
              if (title && title.length > 3) {
                items.push({
                  title,
                  url: href,
                  content: contentEl?.textContent?.trim().substring(0, 500) || '',
                  publishedAt: dateEl?.textContent?.trim() ? new Date(dateEl.textContent.trim()) : new Date()
                });
              }
            }
          });
          if (items.length > 0) break;
        }
      }

      return items.slice(0, 100);
    });

    // URL 정규화
    const baseUrl = 'https://www.thebell.co.kr';
    const normalized = articles
      .filter((a) => a.title && a.url && a.title.length > 3)
      .map((a) => ({
        ...a,
        url: a.url.startsWith('http') ? a.url : `${baseUrl}${a.url.startsWith('/') ? '' : '/'}${a.url}`
      }));

    console.log(`[Thebell] Scraped ${normalized.length} articles`);

    await sessionRef.update({
      lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastArticleCount: normalized.length
    });

    return normalized;

  } catch (err: any) {
    console.error('[Thebell] Scraping error:', err.message, err.stack);
    return [];
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
  }
}
