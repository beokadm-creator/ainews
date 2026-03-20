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
exports.generatePipelineOutput = generatePipelineOutput;
exports.createDailyBriefing = createDailyBriefing;
exports.saveBriefingVersion = saveBriefingVersion;
const admin = __importStar(require("firebase-admin"));
const aiService_1 = require("./aiService");
function buildArticleDigest(articles, includeArticleBody) {
    return articles.map((article, index) => {
        const parts = [
            `[${index + 1}] ${article.title}`,
            `Source: ${article.source}`,
            `PublishedAt: ${article.publishedAt?.toDate ? article.publishedAt.toDate().toISOString() : article.publishedAt || ''}`,
            `Category: ${article.category || 'other'}`,
            `RelevanceScore: ${article.relevanceScore || 0}`,
            `Summary: ${(article.summary || []).join(' ')}`,
            `DealAmount: ${article.deal?.amount || 'undisclosed'}`,
            `Tags: ${(article.tags || []).join(', ')}`
        ];
        if (includeArticleBody) {
            parts.push(`Body: ${(article.content || '').substring(0, 4000)}`);
        }
        return parts.join('\n');
    }).join('\n\n');
}
function normalizeOutputPayload(type, raw, articles) {
    if (type === 'article_list') {
        return {
            type,
            text: '',
            structured: {
                totalArticles: articles.length,
                articles: articles.map(article => ({
                    id: article.id,
                    title: article.title,
                    source: article.source,
                    url: article.url,
                    category: article.category || null,
                    summary: article.summary || [],
                    relevanceScore: article.relevanceScore || 0,
                    tags: article.tags || []
                }))
            }
        };
    }
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            return {
                type,
                text: raw,
                structured: JSON.parse(jsonMatch[0])
            };
        }
        catch {
            return { type, text: raw, structured: null };
        }
    }
    return { type, text: raw, structured: null };
}
async function generatePipelineOutput(articles, options) {
    const db = admin.firestore();
    const outputType = options.outputConfig.type;
    if (articles.length === 0) {
        return {
            success: false,
            outputId: null,
            message: 'No analyzed articles available'
        };
    }
    const limitedArticles = articles.slice(0, options.outputConfig.maxArticles || 50);
    const digest = buildArticleDigest(limitedArticles, !!options.outputConfig.includeArticleBody);
    let prompt = '';
    let rawOutput = '';
    if (outputType === 'article_list') {
        rawOutput = JSON.stringify({
            totalArticles: limitedArticles.length,
            articles: limitedArticles.map(article => ({
                id: article.id,
                title: article.title,
                source: article.source,
                url: article.url,
                category: article.category || null,
                summary: article.summary || [],
                relevanceScore: article.relevanceScore || 0,
                tags: article.tags || []
            }))
        });
    }
    else {
        const basePrompt = outputType === 'custom_prompt'
            ? (options.outputConfig.prompt || options.aiConfig.outputPrompt || 'Analyze the following articles and return the requested output.')
            : (options.aiConfig.outputPrompt || `You are preparing an executive analysis report from analyzed investment news.

Return JSON with this shape:
{
  "title": "string",
  "summary": "string",
  "highlights": [
    { "title": "string", "description": "string", "articleIndex": 1 }
  ],
  "themes": [
    { "name": "string", "description": "string" }
  ],
  "risks": ["string"],
  "opportunities": ["string"],
  "nextSteps": ["string"]
}`);
        prompt = `${basePrompt}

Company: ${options.companyId}
Output title: ${options.outputConfig.title || 'AI News Output'}
Article digest:
${digest}`;
        const response = await (0, aiService_1.callAiProvider)(prompt, options.aiConfig, { temperature: 0.3 }, options.companyId);
        rawOutput = response.content;
        await (0, aiService_1.logPromptExecution)(outputType === 'custom_prompt' ? 'custom-output' : 'daily-briefing', { articleCount: limitedArticles.length, outputType }, rawOutput, options.aiConfig.model, {
            companyId: options.companyId,
            pipelineRunId: options.pipelineRunId,
            prompt
        });
    }
    const normalized = normalizeOutputPayload(outputType, rawOutput, limitedArticles);
    const outputRef = db.collection('outputs').doc();
    await outputRef.set({
        id: outputRef.id,
        companyId: options.companyId,
        pipelineRunId: options.pipelineRunId || null,
        type: outputType,
        title: options.outputConfig.title || normalized.structured?.title || 'AI News Output',
        articleIds: limitedArticles.map(article => article.id),
        articleCount: limitedArticles.length,
        rawOutput: normalized.text,
        structuredOutput: normalized.structured,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    const batch = db.batch();
    limitedArticles.forEach(article => {
        batch.update(db.collection('articles').doc(article.id), {
            status: 'published',
            publishedInOutputId: outputRef.id
        });
    });
    await batch.commit();
    return {
        success: true,
        outputId: outputRef.id,
        outputType,
        articleCount: limitedArticles.length
    };
}
async function createDailyBriefing(options) {
    if (!options) {
        throw new Error('createDailyBriefing now requires runtime options');
    }
    const db = admin.firestore();
    let queryRef = db.collection('articles')
        .where('status', '==', 'analyzed')
        .where('companyId', '==', options.companyId);
    if (options.pipelineRunId) {
        queryRef = queryRef.where('pipelineRunId', '==', options.pipelineRunId);
    }
    const articlesSnapshot = await queryRef.get();
    const articles = articlesSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
    }));
    const sorted = [...articles].sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
    return generatePipelineOutput(sorted, options);
}
async function saveBriefingVersion(outputId, updatedData, changeType = 'edited') {
    const db = admin.firestore();
    const outputRef = db.collection('outputs').doc(outputId);
    const versionsSnapshot = await outputRef.collection('versions')
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();
    const nextVersion = versionsSnapshot.empty
        ? 1
        : (versionsSnapshot.docs[0].data()?.version || 0) + 1;
    await outputRef.collection('versions').add({
        version: nextVersion,
        changeType,
        data: updatedData,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
}
//# sourceMappingURL=briefingService.js.map