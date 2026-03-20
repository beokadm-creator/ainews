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
exports.fetchRssFeed = fetchRssFeed;
exports.processRssSources = processRssSources;
const rss_parser_1 = __importDefault(require("rss-parser"));
const admin = __importStar(require("firebase-admin"));
const duplicateService_1 = require("./duplicateService");
const telegramService_1 = require("./telegramService");
const encodingUtils_1 = require("../utils/encodingUtils");
const textUtils_1 = require("../utils/textUtils");
const runtimeConfigService_1 = require("./runtimeConfigService");
const parser = new rss_parser_1.default({
    customFields: {
        item: [
            ['content:encoded', 'contentEncoded'],
            ['description', 'description']
        ]
    }
});
async function fetchRssFeed(url) {
    const feed = await parser.parseURL(url);
    const articles = [];
    for (const item of feed.items) {
        const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
        if (!item.title || !item.link)
            continue;
        let content = item.contentEncoded || item.description || item.content || '';
        content = (0, encodingUtils_1.fixEncodingIssues)(content);
        content = (0, encodingUtils_1.cleanHtmlContent)(content);
        articles.push({
            title: (0, encodingUtils_1.fixEncodingIssues)(item.title || ''),
            url: item.link,
            content,
            publishedAt: pubDate
        });
    }
    return articles;
}
async function processRssSources(options) {
    const db = admin.firestore();
    const { startDate, endDate } = (0, runtimeConfigService_1.getDateRangeBounds)(options?.filters?.dateRange);
    // ── 소스 목록 수집: legacy sources + globalSources 구독 모두 처리
    const allSourcesToProcess = [];
    // 1) Legacy company-specific sources
    let legacyQuery = db.collection('sources')
        .where('type', '==', 'rss')
        .where('active', '==', true);
    if (options?.companyId) {
        legacyQuery = legacyQuery.where('companyId', '==', options.companyId);
    }
    const legacySnap = await legacyQuery.get();
    legacySnap.docs.forEach(d => allSourcesToProcess.push({ id: d.id, data: d.data(), isGlobal: false }));
    // 2) GlobalSources (구독 sourceIds 기반)
    const subscribedIds = options?.filters?.sourceIds ?? [];
    if (subscribedIds.length > 0) {
        // Firestore 'in' 최대 30개씩 배치
        const chunks = [];
        for (let i = 0; i < subscribedIds.length; i += 30)
            chunks.push(subscribedIds.slice(i, i + 30));
        for (const chunk of chunks) {
            const globalSnap = await db.collection('globalSources')
                .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
                .where('type', '==', 'rss')
                .where('status', '==', 'active')
                .get();
            globalSnap.docs.forEach(d => {
                const data = d.data();
                // 이미 legacy에 있는 ID 제외
                if (!allSourcesToProcess.find(s => s.id === d.id)) {
                    allSourcesToProcess.push({
                        id: d.id,
                        data: { ...data, url: data.rssUrl || data.url, companyId: options?.companyId },
                        isGlobal: true,
                    });
                }
            });
        }
    }
    let totalCollected = 0;
    for (const { id: sourceId, data: source, isGlobal } of allSourcesToProcess) {
        const docRef = isGlobal
            ? db.collection('globalSources').doc(sourceId)
            : db.collection('sources').doc(sourceId);
        try {
            const articles = await fetchRssFeed(source.url || source.rssUrl);
            let sourceCollected = 0;
            for (const article of articles) {
                if (startDate && article.publishedAt < startDate)
                    continue;
                if (endDate && article.publishedAt > endDate)
                    continue;
                const anyKeywords = [
                    ...(source.keywords || source.defaultKeywords || []),
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
                    sourceId,
                    globalSourceId: isGlobal ? sourceId : null,
                    collectedAt: admin.firestore.FieldValue.serverTimestamp(),
                    status: 'pending',
                    urlHash: (0, duplicateService_1.hashUrl)(article.url)
                });
                sourceCollected++;
                totalCollected++;
            }
            await docRef.update({
                lastScrapedAt: admin.firestore.FieldValue.serverTimestamp(),
                lastStatus: 'success',
                errorMessage: null
            });
            console.log(`Processed ${sourceCollected} new RSS articles from ${source.name}${isGlobal ? ' [global]' : ''}`);
        }
        catch (error) {
            await docRef.update({
                lastStatus: 'error',
                errorMessage: error.message
            }).catch(() => { });
            await (0, telegramService_1.sendErrorNotificationToAdmin)('RSS collection failed', error.message, source.name);
        }
    }
    return { success: true, totalCollected };
}
//# sourceMappingURL=rssService.js.map