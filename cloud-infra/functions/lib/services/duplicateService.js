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
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeUrl = normalizeUrl;
exports.hashUrl = hashUrl;
exports.hashTitle = hashTitle;
exports.calculateSimilarity = calculateSimilarity;
exports.calculateTokenSimilarity = calculateTokenSimilarity;
exports.isDuplicateArticle = isDuplicateArticle;
const admin = __importStar(require("firebase-admin"));
const aiService_1 = require("./aiService");
function normalizeUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname.includes('naver.com')) {
            const oid = parsed.searchParams.get('oid');
            const aid = parsed.searchParams.get('aid');
            if (oid && aid)
                return `${parsed.origin}${parsed.pathname}?oid=${oid}&aid=${aid}`;
        }
        return `${parsed.origin}${parsed.pathname}`;
    }
    catch {
        return url;
    }
}
function hashUrl(url) {
    const normalized = normalizeUrl(url);
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}
function hashTitle(title) {
    return title.replace(/\s+/g, '').toLowerCase().substring(0, 12);
}
function calculateSimilarity(str1, str2) {
    if (!str1 || !str2)
        return 0;
    const s1 = str1.replace(/\s+/g, '').toLowerCase();
    const s2 = str2.replace(/\s+/g, '').toLowerCase();
    if (s1 === s2)
        return 1;
    if (s1.length < 2 || s2.length < 2)
        return 0;
    let matchCount = 0;
    for (let i = 0; i < s1.length - 1; i++) {
        const bigram = s1.substring(i, i + 2);
        if (s2.includes(bigram))
            matchCount++;
    }
    return (2 * matchCount) / (s1.length + s2.length - 2);
}
function calculateTokenSimilarity(str1, str2) {
    const tokens1 = new Set(str1.toLowerCase().split(/\s+/).filter(Boolean));
    const tokens2 = new Set(str2.toLowerCase().split(/\s+/).filter(Boolean));
    if (tokens1.size === 0 || tokens2.size === 0)
        return 0;
    const intersection = [...tokens1].filter(token => tokens2.has(token));
    return intersection.length / Math.sqrt(tokens1.size * tokens2.size);
}
async function checkSemanticDuplicateWithAI(article1, article2, aiConfig) {
    const prompt = `Determine if these two articles describe the same event or deal.
Answer with:
DUPLICATE: YES or NO
REASON: short reason

Article A
Title: ${article1.title}
Content: ${(article1.content || '').substring(0, 300)}

Article B
Title: ${article2.title}
Content: ${(article2.content || '').substring(0, 300)}`;
    try {
        const result = await (0, aiService_1.callAiProvider)(prompt, aiConfig, { temperature: 0.1, maxTokens: 30 });
        const duplicateMatch = result.content.match(/DUPLICATE:\s*(YES|NO)/i) || result.content.match(/^(YES|NO)\b/i);
        await (0, aiService_1.logPromptExecution)('dedup-check', { title_a: article1.title, title_b: article2.title }, result.content, aiConfig.model);
        return duplicateMatch ? duplicateMatch[1].toUpperCase() === 'YES' : false;
    }
    catch (error) {
        console.error('AI duplicate check failed:', error);
        return false;
    }
}
async function isDuplicateArticle(newArticle, options) {
    const db = admin.firestore();
    const normalizedUrl = normalizeUrl(newArticle.url);
    const urlHash = hashUrl(newArticle.url);
    const titleHash = hashTitle(newArticle.title);
    let exactUrlQuery = db.collection('articles')
        .where('url', '==', newArticle.url);
    if (options?.companyId) {
        exactUrlQuery = exactUrlQuery.where('companyId', '==', options.companyId);
    }
    const exactUrlSnapshot = await exactUrlQuery.limit(1).get();
    if (!exactUrlSnapshot.empty) {
        return { isDuplicate: true, reason: 'Exact URL match', duplicateOf: exactUrlSnapshot.docs[0].id };
    }
    let hashQuery = db.collection('articles')
        .where('urlHash', '==', urlHash);
    if (options?.companyId) {
        hashQuery = hashQuery.where('companyId', '==', options.companyId);
    }
    const hashSnapshot = await hashQuery.limit(5).get();
    for (const doc of hashSnapshot.docs) {
        const existingArticle = doc.data();
        if (normalizeUrl(existingArticle.url) === normalizedUrl) {
            return { isDuplicate: true, reason: 'Normalized URL match', duplicateOf: doc.id };
        }
    }
    const oneDayAgo = new Date();
    oneDayAgo.setDate(oneDayAgo.getDate() - 1);
    let recentQuery = db.collection('articles')
        .where('collectedAt', '>=', admin.firestore.Timestamp.fromDate(oneDayAgo));
    if (options?.companyId) {
        recentQuery = recentQuery.where('companyId', '==', options.companyId);
    }
    const recentArticlesSnapshot = await recentQuery.get();
    for (const doc of recentArticlesSnapshot.docs) {
        const existingArticle = doc.data();
        if (hashTitle(existingArticle.title) !== titleHash)
            continue;
        const titleSim = calculateTokenSimilarity(newArticle.title, existingArticle.title);
        if (titleSim > 0.92) {
            return { isDuplicate: true, reason: 'High title similarity', duplicateOf: doc.id };
        }
        if (options?.aiConfig && (titleSim > 0.65 || calculateSimilarity(newArticle.title, existingArticle.title) > 0.75)) {
            const isSemanticDup = await checkSemanticDuplicateWithAI(newArticle, existingArticle, options.aiConfig);
            if (isSemanticDup) {
                return { isDuplicate: true, reason: 'AI semantic match', duplicateOf: doc.id };
            }
        }
    }
    return { isDuplicate: false };
}
//# sourceMappingURL=duplicateService.js.map