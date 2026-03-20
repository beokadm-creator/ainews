"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processPuppeteerSources = processPuppeteerSources;
const puppeteer_extra_1 = __importDefault(require("puppeteer-extra"));
const puppeteer_extra_plugin_stealth_1 = __importDefault(require("puppeteer-extra-plugin-stealth"));
const admin = __importStar(require("firebase-admin"));
const duplicateService_1 = require("./duplicateService");
const telegramService_1 = require("./telegramService");
const textUtils_1 = require("../utils/textUtils");
const encodingUtils_1 = require("../utils/encodingUtils");
const runtimeConfigService_1 = require("./runtimeConfigService");
puppeteer_extra_1.default.use((0, puppeteer_extra_plugin_stealth_1.default)());
async function getCookies(sourceId) {
    const db = admin.firestore();
    const sessionDoc = await db.collection('sessions').doc(sourceId).get();
    return sessionDoc.exists && sessionDoc.data()?.cookies ? sessionDoc.data().cookies : [];
}
const puppeteerScraperMap = {
    default: async (page, baseUrl) => {
        const articles = [];
        await page.goto(baseUrl, { waitUntil: 'networkidle2' });
        const items = await page.$$('article, .article, .post, .news-item, .list-item');
        for (const item of items) {
            const titleEl = await item.$('h1 a, h2 a, h3 a, .title a, .link');
            if (!titleEl)
                continue;
            const title = await page.evaluate((el) => el.textContent.trim(), titleEl);
            const href = await page.evaluate((el) => el.getAttribute('href'), titleEl);
            const url = href?.startsWith('http') ? href : `${baseUrl}/${href}`;
            const contentEl = await item.$('p, .summary, .description, .excerpt');
            const content = contentEl ? await page.evaluate((el) => el.textContent.trim(), contentEl) : '';
            if (title && url) {
                articles.push({ title, url, content, publishedAt: new Date() });
            }
        }
        return articles;
    }
};
async function scrapePuppeteerDynamic(page, url, source) {
    const articles = [];
    await page.goto(url, { waitUntil: 'networkidle2' });
    const listSelector = source.listSelector
        ? source.listSelector
        : (source.selector ? source.selector : 'article, .article, .post, .news-item, .list-item');
    const items = await page.$$(listSelector);
    for (const item of items) {
        const titleEl = source.titleSelector
            ? await item.$(source.titleSelector)
            : await item.$('h1 a, h2 a, h3 a, .title a, .link');
        if (!titleEl)
            continue;
        const title = await page.evaluate((el) => el.textContent.trim(), titleEl);
        let href = '';
        if (source.linkSelector) {
            const linkEl = await item.$(source.linkSelector);
            if (linkEl) {
                href = await page.evaluate((el) => el.getAttribute('href') || '', linkEl);
            }
        }
        else {
            href = await page.evaluate((el) => el.getAttribute('href'), titleEl);
        }
        const urlObj = new URL(url);
        const finalUrl = href?.startsWith('http')
            ? href
            : (href?.startsWith('/') ? `${urlObj.origin}${href}` : `${urlObj.origin}/${href}`);
        let content = '';
        const contentEl = source.contentSelector ? await item.$(source.contentSelector) : await item.$('p, .summary, .description, .excerpt');
        if (contentEl) {
            content = await page.evaluate((el) => el.textContent.trim(), contentEl);
        }
        let publishedAt = new Date();
        if (source.dateSelector) {
            const dateEl = await item.$(source.dateSelector);
            if (dateEl) {
                const dateText = await page.evaluate((el) => el.textContent.trim(), dateEl);
                const parsedDate = new Date(dateText);
                if (!isNaN(parsedDate.getTime()))
                    publishedAt = parsedDate;
            }
        }
        if (title && finalUrl) {
            articles.push({
                title: (0, encodingUtils_1.fixEncodingIssues)(title),
                url: finalUrl,
                content: (0, encodingUtils_1.fixEncodingIssues)(content),
                publishedAt
            });
        }
    }
    return articles;
}
async function enrichArticles(page, articles) {
    return Promise.all(articles.map(async (article) => {
        if ((0, textUtils_1.isContentSufficient)(article.content, 100))
            return article;
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
                const cleanedContent = (0, textUtils_1.cleanNoise)(pageContent);
                if ((0, textUtils_1.isContentSufficient)(cleanedContent, 50)) {
                    return {
                        ...article,
                        content: cleanedContent.substring(0, 5000)
                    };
                }
            }
        }
        catch (error) {
            console.warn(`Failed to fetch full article from ${article.url}:`, error);
        }
        return article;
    }));
}
async function processPuppeteerSources(options) {
    const db = admin.firestore();
    const { startDate, endDate } = (0, runtimeConfigService_1.getDateRangeBounds)(options?.filters?.dateRange);
    let browser = null;
    let sourcesQuery = db.collection('sources')
        .where('type', '==', 'puppeteer')
        .where('active', '==', true);
    if (options?.companyId) {
        sourcesQuery = sourcesQuery.where('companyId', '==', options.companyId);
    }
    if (options?.filters?.sourceIds && options.filters.sourceIds.length > 0) {
        sourcesQuery = sourcesQuery.where(admin.firestore.FieldPath.documentId(), 'in', options.filters.sourceIds.slice(0, 10));
    }
    const sourcesSnapshot = await sourcesQuery.get();
    if (sourcesSnapshot.empty) {
        return { success: true, totalCollected: 0 };
    }
    let totalCollected = 0;
    try {
        browser = await puppeteer_extra_1.default.launch({
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
                    if (startDate && article.publishedAt < startDate)
                        continue;
                    if (endDate && article.publishedAt > endDate)
                        continue;
                    const anyKeywords = [
                        ...(source.keywords || []),
                        ...(options?.filters?.keywords || [])
                    ];
                    if (!(0, textUtils_1.matchesRuntimeFilters)(article.title, article.content, {
                        anyKeywords,
                        includeKeywords: options?.filters?.includeKeywords,
                        excludeKeywords: options?.filters?.excludeKeywords,
                        sectors: options?.filters?.sectors
                    })) {
                        continue;
                    }
                    const dupCheck = await (0, duplicateService_1.isDuplicateArticle)(article, {
                        companyId: source.companyId || options?.companyId
                    });
                    if (dupCheck.isDuplicate)
                        continue;
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
                        urlHash: (0, duplicateService_1.hashUrl)(article.url)
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
            }
            catch (error) {
                await doc.ref.update({
                    lastStatus: 'error',
                    errorMessage: error.message
                });
                await (0, telegramService_1.sendErrorNotificationToAdmin)('Puppeteer collection failed', error.message, source.name);
            }
            finally {
                await page.close();
            }
        }
    }
    finally {
        if (browser) {
            await browser.close();
        }
    }
    return { success: true, totalCollected };
}
//# sourceMappingURL=puppeteerService.js.map