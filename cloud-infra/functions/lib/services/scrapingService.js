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
exports.scrapeWebsiteDynamic = scrapeWebsiteDynamic;
exports.scrapeWebsite = scrapeWebsite;
exports.processScrapingSources = processScrapingSources;
const cheerio = __importStar(require("cheerio"));
const axios_1 = __importDefault(require("axios"));
const admin = __importStar(require("firebase-admin"));
const duplicateService_1 = require("./duplicateService");
const telegramService_1 = require("./telegramService");
const textUtils_1 = require("../utils/textUtils");
const encodingUtils_1 = require("../utils/encodingUtils");
const runtimeConfigService_1 = require("./runtimeConfigService");
const scraperMap = {
    hankyung_ma: (html, baseUrl) => {
        const $ = cheerio.load(html);
        const articles = [];
        $('.news-list li').each((_, element) => {
            const titleElement = $(element).find('h3.title a');
            const title = (0, encodingUtils_1.fixEncodingIssues)(titleElement.text().trim());
            let url = titleElement.attr('href') || '';
            const summary = (0, encodingUtils_1.fixEncodingIssues)($(element).find('.lead').text().trim());
            if (url.startsWith('/')) {
                const urlObj = new URL(baseUrl);
                url = `${urlObj.origin}${url}`;
            }
            if (title && url) {
                articles.push({
                    title,
                    url,
                    content: summary,
                    publishedAt: new Date()
                });
            }
        });
        return articles;
    },
    default: (html, baseUrl) => {
        const $ = cheerio.load(html);
        const articles = [];
        $('article, .article, .post, .news-item').each((_, element) => {
            const titleElement = $(element).find('h1, h2, h3, .title').find('a').first();
            if (!titleElement.length)
                return;
            const title = (0, encodingUtils_1.fixEncodingIssues)(titleElement.text().trim());
            let url = titleElement.attr('href') || '';
            const content = (0, encodingUtils_1.fixEncodingIssues)($(element).find('p, .summary, .description').text().trim());
            if (url.startsWith('/')) {
                const urlObj = new URL(baseUrl);
                url = `${urlObj.origin}${url}`;
            }
            if (title && url) {
                articles.push({
                    title,
                    url,
                    content,
                    publishedAt: new Date()
                });
            }
        });
        return articles;
    }
};
async function enrichArticles(articles) {
    return Promise.all(articles.map(async (article) => {
        if ((0, textUtils_1.isContentSufficient)(article.content, 100)) {
            return article;
        }
        try {
            const articleResponse = await axios_1.default.get(article.url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0'
                },
                timeout: 10000
            });
            const fullContent = (0, textUtils_1.extractTextFromHtml)(articleResponse.data);
            const cleanedContent = (0, textUtils_1.cleanNoise)(fullContent);
            if ((0, textUtils_1.isContentSufficient)(cleanedContent, 50)) {
                return {
                    ...article,
                    content: cleanedContent.substring(0, 5000)
                };
            }
        }
        catch (error) {
            console.warn(`Failed to fetch full article from ${article.url}:`, error);
        }
        return article;
    }));
}
async function scrapeWebsiteDynamic(url, source) {
    const response = await axios_1.default.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout: 10000
    });
    const $ = cheerio.load(response.data);
    const articles = [];
    const listContainer = source.listSelector
        ? $(source.listSelector)
        : (source.selector ? $(source.selector) : $('article, .article, .post, .news-item'));
    listContainer.each((_, element) => {
        const titleEl = source.titleSelector
            ? $(element).find(source.titleSelector).first()
            : $(element).find('h1, h2, h3, .title').find('a').first();
        if (!titleEl.length)
            return;
        const title = (0, encodingUtils_1.fixEncodingIssues)(titleEl.text().trim());
        let href = source.linkSelector
            ? ($(element).find(source.linkSelector).first().attr('href') || '')
            : (titleEl.attr('href') || '');
        const urlObj = new URL(url);
        if (href.startsWith('/'))
            href = `${urlObj.origin}${href}`;
        else if (!href.startsWith('http'))
            href = `${urlObj.origin}/${href.replace(/^\//, '')}`;
        const contentEl = source.contentSelector
            ? $(element).find(source.contentSelector)
            : $(element).find('p, .summary, .description');
        const content = (0, encodingUtils_1.fixEncodingIssues)(contentEl.text().trim());
        let publishedAt = new Date();
        if (source.dateSelector) {
            const dateText = $(element).find(source.dateSelector).first().text().trim();
            const parsedDate = new Date(dateText);
            if (!isNaN(parsedDate.getTime()))
                publishedAt = parsedDate;
        }
        if (title && href) {
            articles.push({ title, url: href, content, publishedAt });
        }
    });
    return enrichArticles(articles);
}
async function scrapeWebsite(url, sourceId) {
    const response = await axios_1.default.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
        },
        timeout: 10000
    });
    const scraper = scraperMap[sourceId] || scraperMap.default;
    const articles = scraper(response.data, url);
    return enrichArticles(articles);
}
async function processScrapingSources(options) {
    const db = admin.firestore();
    const { startDate, endDate } = (0, runtimeConfigService_1.getDateRangeBounds)(options?.filters?.dateRange);
    let sourcesQuery = db.collection('sources')
        .where('type', '==', 'scraping')
        .where('active', '==', true);
    if (options?.companyId) {
        sourcesQuery = sourcesQuery.where('companyId', '==', options.companyId);
    }
    if (options?.filters?.sourceIds && options.filters.sourceIds.length > 0) {
        sourcesQuery = sourcesQuery.where(admin.firestore.FieldPath.documentId(), 'in', options.filters.sourceIds.slice(0, 10));
    }
    const sourcesSnapshot = await sourcesQuery.get();
    let totalCollected = 0;
    for (const doc of sourcesSnapshot.docs) {
        const source = doc.data();
        try {
            const articles = scraperMap[doc.id]
                ? await scrapeWebsite(source.url, doc.id)
                : await scrapeWebsiteDynamic(source.url, source);
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
            await doc.ref.update({
                lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
                lastStatus: 'success',
                errorMessage: null
            });
            console.log(`Processed ${sourceCollected} scraped articles from ${source.name}`);
        }
        catch (error) {
            await doc.ref.update({
                lastStatus: 'error',
                errorMessage: error.message
            });
            await (0, telegramService_1.sendErrorNotificationToAdmin)('Scraping collection failed', error.message, source.name);
        }
    }
    return { success: true, totalCollected };
}
//# sourceMappingURL=scrapingService.js.map