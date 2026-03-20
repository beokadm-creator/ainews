import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as admin from 'firebase-admin';
import { isDuplicateArticle, hashUrl } from './duplicateService';
import { sendErrorNotificationToAdmin } from './telegramService';
import { isContentSufficient, cleanNoise, matchesRuntimeFilters } from '../utils/textUtils';
import { fixEncodingIssues } from '../utils/encodingUtils';
import { RuntimeFilters } from '../types/runtime';
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
  if (sourcesSnapshot.empty) {
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

    for (const doc of sourcesSnapshot.docs) {
      const source = doc.data();
      const page = await browser.newPage();

      try {
        await page.setUserAgent('Mozilla/5.0');

        if (source.authType === 'session' || source.authType === 'puppeteer') {
          const cookies = await getCookies(doc.id);
          if (cookies.length > 0) {
            await page.setCookie(...cookies);
          }
        }

        const baseArticles = puppeteerScraperMap[doc.id]
          ? await puppeteerScraperMap[doc.id](page, source.url)
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
            companyId: source.companyId || options?.companyId
          });
          if (dupCheck.isDuplicate) continue;

          const articleRef = db.collection('articles').doc();
          await articleRef.set({
            id: articleRef.id,
            ...article,
            companyId: source.companyId || options?.companyId || null,
            pipelineRunId: options?.pipelineRunId || null,
            source: source.name,
            sourceId: doc.id,
            collectedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'pending',
            urlHash: hashUrl(article.url)
          });

          sourceCollected++;
          totalCollected++;
        }

        if (source.authType === 'session' || source.authType === 'puppeteer') {
          const currentCookies = await page.cookies();
          await db.collection('sessions').doc(doc.id).set({
            cookies: currentCookies,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }

        await doc.ref.update({
          lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastStatus: 'success',
          errorMessage: null
        });

        console.log(`Processed ${sourceCollected} puppeteer articles from ${source.name}`);
      } catch (error: any) {
        await doc.ref.update({
          lastStatus: 'error',
          errorMessage: error.message
        });
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
