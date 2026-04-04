import * as admin from 'firebase-admin';
import puppeteer from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { isDuplicateArticle, hashTitle, hashUrl } from './duplicateService';
import { recordArticleDedupEntry } from './articleDedupService';
import { RuntimeAiConfig, RuntimeFilters } from '../types/runtime';
import { getDateRangeBounds } from './runtimeConfigService';
import { extractTextFromHtml } from '../utils/textUtils';

const PAGE_TIMEOUT_MS = 30_000;
const MAX_LIST_ITEMS = 20;
const MIN_FULL_BODY_CHARS = 500;
const MAX_BODY_CHARS = 50000;

interface PuppeteerSource {
  id: string;
  name: string;
  url: string;
  type?: string;
  category?: string;
  listSelector?: string;
  titleSelector?: string;
  linkSelector?: string;
  contentSelector?: string;
  dateSelector?: string;
  pricingTier?: string | null;
  authType?: string | null;
  loginRequired?: boolean;
  localScraperId?: string | null;
  status?: string;
}

interface PuppeteerArticle {
  title: string;
  url: string;
  content: string;
  publishedAt: Date;
}

function parsePublishedAt(rawValue?: string | null): Date {
  if (!rawValue) return new Date();
  const normalized = `${rawValue}`.trim().replace(/\./g, '-').replace(/\//g, '-');
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function getLaunchOptions() {
  const executablePath = await chromium.executablePath();
  return {
    headless: true,
    executablePath,
    args: chromium.args,
  };
}

async function loadCookies(source: PuppeteerSource) {
  const db = admin.firestore();
  const candidateIds = [source.id, source.localScraperId].filter((value): value is string => Boolean(value));
  for (const candidateId of candidateIds) {
    const sessionDoc = await db.collection('sessions').doc(candidateId).get();
    const cookies = sessionDoc.data()?.cookies;
    if (Array.isArray(cookies) && cookies.length > 0) {
      return cookies;
    }
  }
  return [];
}

async function persistCookies(source: PuppeteerSource, cookies: Awaited<ReturnType<Page['cookies']>>) {
  const db = admin.firestore();
  const candidateIds = [source.id, source.localScraperId].filter((value): value is string => Boolean(value));
  await Promise.all(candidateIds.map(async (candidateId) => {
    await db.collection('sessions').doc(candidateId).set({
      cookies,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }));
}

async function listPuppeteerSources(filters?: RuntimeFilters) {
  const db = admin.firestore();
  const sourceIds = filters?.sourceIds || [];
  if (sourceIds.length === 0) {
    const snap = await db.collection('globalSources')
      .where('type', '==', 'puppeteer')
      .where('status', '==', 'active')
      .get();

    return snap.docs.map((doc) => ({ id: doc.id, data: doc.data() as PuppeteerSource }));
  }

  const docs: Array<{ id: string; data: PuppeteerSource }> = [];
  const seen = new Set<string>();

  for (const chunk of chunkArray(sourceIds, 10)) {
    const snap = await db.collection('globalSources')
      .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
      .get();

    snap.docs.forEach((doc) => {
      if (seen.has(doc.id)) return;
      const data = doc.data() as PuppeteerSource;
      if (data.type !== 'puppeteer' || data.status !== 'active') return;
      seen.add(doc.id);
      docs.push({ id: doc.id, data });
    });
  }

  return docs;
}

async function scrapeListing(page: Page, source: PuppeteerSource): Promise<PuppeteerArticle[]> {
  if (!source.listSelector || !source.titleSelector) {
    throw new Error(`Puppeteer source '${source.name}' is missing required selectors.`);
  }

  await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
  await page.waitForSelector(source.listSelector, { timeout: 10_000 });

  const rows = await page.$$eval(
    source.listSelector,
    (nodes, selectors) => {
      return (nodes as Element[]).slice(0, selectors.limit).map((node: Element) => {
        const root = node as HTMLElement;
        const titleNode = root.querySelector(selectors.titleSelector);
        const linkNode = selectors.linkSelector
          ? root.querySelector(selectors.linkSelector)
          : titleNode;
        const dateNode = selectors.dateSelector
          ? root.querySelector(selectors.dateSelector)
          : null;
        const summaryNode = selectors.contentSelector
          ? root.querySelector(selectors.contentSelector)
          : null;

        const title = titleNode?.textContent?.trim() || '';
        const href = (linkNode as HTMLAnchorElement | null)?.getAttribute('href') || '';
        const url = href ? new URL(href, selectors.baseUrl).toString() : '';
        const content = summaryNode?.textContent?.trim() || root.textContent?.trim() || '';
        const publishedAt = dateNode?.textContent?.trim() || '';

        return { title, url, content, publishedAt };
      });
    },
    {
      baseUrl: source.url,
      titleSelector: source.titleSelector,
      linkSelector: source.linkSelector || source.titleSelector,
      contentSelector: source.contentSelector || null,
      dateSelector: source.dateSelector || null,
      limit: MAX_LIST_ITEMS,
    },
  );

  return rows
    .filter((row: { title: string; url: string }) => row.title && row.url)
    .map((row: { title: string; url: string; content: string; publishedAt: string }) => ({
      title: row.title,
      url: row.url,
      content: row.content || '',
      publishedAt: parsePublishedAt(row.publishedAt),
    }));
}

async function enrichArticles(browser: Browser, source: PuppeteerSource, baseArticles: PuppeteerArticle[]) {
  const articlePage = await browser.newPage();
  try {
    const enriched: PuppeteerArticle[] = [];
    for (const article of baseArticles) {
      const currentContent = `${article.content || ''}`.trim();
      if (currentContent.length >= MIN_FULL_BODY_CHARS) {
        enriched.push(article);
        continue;
      }

      try {
        await articlePage.goto(article.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
        const articleHtml = await articlePage.content();
        let normalized = extractTextFromHtml(articleHtml, article.url)
          .replace(/\r/g, '\n')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        if (normalized.length < MIN_FULL_BODY_CHARS) {
          const content = await articlePage.evaluate((preferredSelector: string | null) => {
            const selectors = [
              preferredSelector,
              'article',
              '.article',
              '.article_view',
              '.article-body',
              '.article_content',
              '.news_body',
              '.view_cont',
              '.contents',
              'main',
            ].filter((value): value is string => Boolean(value));

            for (const selector of selectors) {
              const node = document.querySelector(selector);
              const text = node?.textContent?.trim();
              if (text && text.length > 80) {
                return text;
              }
            }

            return document.body?.textContent?.trim() || '';
          }, source.contentSelector || null);

          normalized = content
            .replace(/\r/g, '\n')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }

        if (normalized.length > 0) {
          enriched.push({
            ...article,
            content: normalized.slice(0, MAX_BODY_CHARS),
          });
          continue;
        }
      } catch (error: any) {
        console.warn(`[Puppeteer] Failed to enrich ${article.url}: ${error.message}`);
      }

      enriched.push(article);
    }
    return enriched;
  } finally {
    await articlePage.close().catch(() => {});
  }
}

export async function processPuppeteerSources(options?: {
  companyId?: string;
  pipelineRunId?: string;
  filters?: RuntimeFilters;
  aiConfig?: RuntimeAiConfig;
}) {
  const db = admin.firestore();
  const { startDate, endDate } = getDateRangeBounds(options?.filters?.dateRange);
  const sources = await listPuppeteerSources(options?.filters);

  if (sources.length === 0) {
    console.log('[Puppeteer] no active puppeteer sources found.');
    return { success: true, totalCollected: 0 };
  }

  let browser: Browser | null = null;
  let totalCollected = 0;

  try {
    browser = await puppeteer.launch(await getLaunchOptions());

    for (const { id: sourceId, data } of sources) {
      const source = { ...data, id: sourceId };
      const sourceRef = db.collection('globalSources').doc(sourceId);
      const page = await browser.newPage();

      try {
        // 로그인 필요 소스는 Cloud Run에서 처리 불가 → 로컬 PC 스크래퍼가 담당
        if (source.loginRequired || source.authType === 'session') {
          console.log(`[Puppeteer] ${source.name}: loginRequired=true → skipping (handled by local scraper)`);
          await page.close().catch(() => {});
          continue;
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        const cookies = await loadCookies(source);
        if (cookies.length > 0) {
          await page.setCookie(...cookies);
        }

        const listedArticles = await scrapeListing(page, source);
        const enrichedArticles = await enrichArticles(browser, source, listedArticles);

        let sourceCollected = 0;
        for (const article of enrichedArticles) {
          if (startDate && article.publishedAt < startDate) continue;
          if (endDate && article.publishedAt > endDate) continue;

          const duplicate = await isDuplicateArticle(article, {
            companyId: options?.companyId,
            aiConfig: options?.aiConfig,
            fastMode: true,
          });
          if (duplicate.isDuplicate) continue;

          const articleRef = db.collection('articles').doc();
          await articleRef.set({
            id: articleRef.id,
            ...article,
            companyId: options?.companyId || null,
            pipelineRunId: options?.pipelineRunId || null,
            source: source.name,
            sourceId,
            globalSourceId: sourceId,
            sourceCategory: source.category || null,
            sourcePricingTier: source.pricingTier || (source.loginRequired ? 'paid' : 'free'),
            collectedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'pending',
            urlHash: hashUrl(article.url),
            titleHash: hashTitle(article.title),
          });

          await recordArticleDedupEntry({
            id: articleRef.id,
            ...article,
            companyId: options?.companyId || null,
            sourceId,
            globalSourceId: sourceId,
            source: source.name,
            status: 'pending',
            collectedAt: new Date(),
          });

          sourceCollected++;
          totalCollected++;
        }

        await persistCookies(source, await page.cookies());
        await sourceRef.set({
          lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastStatus: 'success',
          errorMessage: null,
        }, { merge: true });

        console.log(`[Puppeteer] ${source.name}: +${sourceCollected} articles`);
      } catch (error: any) {
        await sourceRef.set({
          lastStatus: 'error',
          errorMessage: error.message || 'Unknown puppeteer error',
        }, { merge: true }).catch(() => {});
        console.error(`[Puppeteer] ${source.name} error:`, error.message || error);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  return { success: true, totalCollected };
}
