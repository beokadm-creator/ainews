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
exports.callAiProvider = callAiProvider;
exports.testAiProviderConnection = testAiProviderConnection;
exports.logPromptExecution = logPromptExecution;
exports.checkRelevance = checkRelevance;
exports.analyzeArticle = analyzeArticle;
exports.processRelevanceFiltering = processRelevanceFiltering;
exports.processDeepAnalysis = processDeepAnalysis;
const axios_1 = __importDefault(require("axios"));
const admin = __importStar(require("firebase-admin"));
const constants_1 = require("../config/constants");
const errorHandling_1 = require("../utils/errorHandling");
const secretManager_1 = require("../utils/secretManager");
const GLM_COST_PER_1K_TOKENS = { input: 0.01, output: 0.01 };
const OPENAI_COST_PER_1K_TOKENS = { input: 0.005, output: 0.015 };
const GEMINI_COST_PER_1K_TOKENS = { input: 0.00035, output: 0.00105 };
const CLAUDE_COST_PER_1K_TOKENS = { input: 0.003, output: 0.015 };
// ─────────────────────────────────────────
// Default Prompts
// ─────────────────────────────────────────
const DEFAULT_RELEVANCE_PROMPT = `You are a professional analyst for M&A, private equity, venture capital, and strategic investment news.

Determine whether the article is relevant to the configured investment monitoring workflow.

Relevant examples:
- mergers and acquisitions
- stake sales, divestitures, carve-outs, spin-offs
- private equity deals and fund activity
- venture capital funding
- strategic investments, IPO-linked deal activity
- capital raise, refinancing, restructuring, management buyout

Output format:
RELEVANT: YES or NO
CONFIDENCE: number between 0.0 and 1.0
REASON: short reason`;
const DEFAULT_ANALYSIS_PROMPT = `You are an analyst that extracts structured investment intelligence from news articles.

Return valid JSON only with this shape:
{
  "companies": {
    "acquiror": "string or null",
    "target": "string or null",
    "financialSponsor": "string or null"
  },
  "deal": {
    "type": "string",
    "amount": "string",
    "stake": "string or null"
  },
  "summary": ["sentence 1", "sentence 2", "sentence 3"],
  "category": "string",
  "insights": "string or null",
  "tags": ["tag1", "tag2", "tag3"]
}`;
// ─────────────────────────────────────────
// Token usage extraction per provider
// ─────────────────────────────────────────
function extractTokenUsage(responseData, provider) {
    switch (provider) {
        case 'glm':
        case 'openai':
            return {
                promptTokens: responseData.usage?.prompt_tokens || 0,
                completionTokens: responseData.usage?.completion_tokens || 0,
                totalTokens: responseData.usage?.total_tokens || 0,
            };
        case 'gemini':
            return {
                promptTokens: responseData.usageMetadata?.promptTokenCount || 0,
                completionTokens: responseData.usageMetadata?.candidatesTokenCount || 0,
                totalTokens: responseData.usageMetadata?.totalTokenCount || 0,
            };
        case 'claude':
            return {
                promptTokens: responseData.usage?.input_tokens || 0,
                completionTokens: responseData.usage?.output_tokens || 0,
                totalTokens: (responseData.usage?.input_tokens || 0) + (responseData.usage?.output_tokens || 0),
            };
        default:
            return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    }
}
function getCostPerKTokens(provider) {
    switch (provider) {
        case 'openai': return OPENAI_COST_PER_1K_TOKENS;
        case 'gemini': return GEMINI_COST_PER_1K_TOKENS;
        case 'claude': return CLAUDE_COST_PER_1K_TOKENS;
        default: return GLM_COST_PER_1K_TOKENS;
    }
}
// ─────────────────────────────────────────
// AI Cost Tracking
// ─────────────────────────────────────────
async function trackAiCost(stage, usage, model, provider, companyId, pipelineRunId) {
    try {
        const db = admin.firestore();
        const costs = getCostPerKTokens(provider);
        const inputCost = (usage.promptTokens / 1000) * costs.input;
        const outputCost = (usage.completionTokens / 1000) * costs.output;
        await db.collection('aiCostTracking').add({
            date: new Date().toISOString().split('T')[0],
            stage,
            provider,
            model,
            companyId: companyId || null,
            pipelineRunId: pipelineRunId || null,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            inputCostUSD: inputCost,
            outputCostUSD: outputCost,
            totalCostUSD: inputCost + outputCost,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    }
    catch {
        // non-critical
    }
}
// ─────────────────────────────────────────
// Rate-limit / error tracking
// ─────────────────────────────────────────
let recentErrorCount = 0;
let lastErrorReset = Date.now();
const ERROR_WINDOW_MS = 5 * 60 * 1000;
const MAX_ERROR_RATE = 0.3;
function getDynamicBatchSize(baseSize) {
    const now = Date.now();
    if (now - lastErrorReset > ERROR_WINDOW_MS) {
        recentErrorCount = 0;
        lastErrorReset = now;
    }
    const errorRate = recentErrorCount / Math.max(baseSize, 1);
    return errorRate > MAX_ERROR_RATE ? Math.max(3, Math.floor(baseSize * 0.5)) : baseSize;
}
function recordError() { recentErrorCount++; }
function getRateLimitDelay(attempt) {
    return Math.min(5000, 500 * Math.pow(2, attempt));
}
// ─────────────────────────────────────────
// Provider-specific API callers
// ─────────────────────────────────────────
async function resolveApiKey(aiConfig, companyId) {
    // 1. company Firestore key first
    if (companyId) {
        const companyKey = await (0, secretManager_1.getApiKeyForCompany)(companyId, aiConfig.provider);
        if (companyKey)
            return companyKey;
    }
    // 2. env var fallback
    return (0, secretManager_1.getApiKeyByEnvKey)(aiConfig.apiKeyEnvKey);
}
async function callGlmApi(prompt, apiKey, aiConfig, options) {
    return (0, errorHandling_1.retryWithBackoff)(async () => {
        // ★ Use custom baseUrl if provided (e.g. https://z.ai/api/v1/chat/completions)
        let url = aiConfig.baseUrl || constants_1.GLM_API_URL;
        if (url.endsWith('/'))
            url = url.slice(0, -1);
        if (!url.endsWith('/chat/completions')) {
            url += '/chat/completions';
        }
        const response = await axios_1.default.post(url, {
            model: aiConfig.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: options?.temperature ?? 0.2,
            ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
        }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
        const rawContent = response.data.choices?.[0]?.message?.content;
        if (rawContent == null) {
            const finishReason = response.data.choices?.[0]?.finish_reason;
            console.error('GLM empty content. finish_reason:', finishReason, 'full response:', JSON.stringify(response.data).substring(0, 500));
            throw new Error(`Model returned empty content. finish_reason: ${finishReason || 'unknown'}. Check model name "${aiConfig.model}" and endpoint.`);
        }
        return {
            content: rawContent.trim(),
            usage: extractTokenUsage(response.data, 'glm'),
        };
    });
}
async function callOpenAiApi(prompt, apiKey, aiConfig, options) {
    return (0, errorHandling_1.retryWithBackoff)(async () => {
        const url = aiConfig.baseUrl || constants_1.OPENAI_API_URL;
        const response = await axios_1.default.post(url, {
            model: aiConfig.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: options?.temperature ?? 0.2,
            ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
        }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
        return {
            content: response.data.choices[0].message.content.trim(),
            usage: extractTokenUsage(response.data, 'openai'),
        };
    });
}
async function callGeminiApi(prompt, apiKey, aiConfig, options) {
    return (0, errorHandling_1.retryWithBackoff)(async () => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${aiConfig.model}:generateContent?key=${apiKey}`;
        const response = await axios_1.default.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: options?.temperature ?? 0.2,
                ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
            },
        }, { headers: { 'Content-Type': 'application/json' } });
        const content = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return {
            content: content.trim(),
            usage: extractTokenUsage(response.data, 'gemini'),
        };
    });
}
async function callClaudeApi(prompt, apiKey, aiConfig, options) {
    return (0, errorHandling_1.retryWithBackoff)(async () => {
        const response = await axios_1.default.post(constants_1.ANTHROPIC_API_URL, {
            model: aiConfig.model,
            max_tokens: options?.maxTokens || 1024,
            messages: [{ role: 'user', content: prompt }],
            temperature: options?.temperature ?? 0.2,
        }, {
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
        });
        const content = response.data.content?.[0]?.text || '';
        return {
            content: content.trim(),
            usage: extractTokenUsage(response.data, 'claude'),
        };
    });
}
// ─────────────────────────────────────────
// Unified API caller (routes by provider)
// ─────────────────────────────────────────
async function callAiProvider(prompt, aiConfig, options, companyId) {
    const apiKey = await resolveApiKey(aiConfig, companyId);
    (0, secretManager_1.validateApiKey)(apiKey, aiConfig.provider);
    switch (aiConfig.provider) {
        case 'openai':
            return callOpenAiApi(prompt, apiKey, aiConfig, options);
        case 'gemini':
            return callGeminiApi(prompt, apiKey, aiConfig, options);
        case 'claude':
            return callClaudeApi(prompt, apiKey, aiConfig, options);
        case 'glm':
        default:
            return callGlmApi(prompt, apiKey, aiConfig, options);
    }
}
// ─────────────────────────────────────────
// Test AI connection (for Settings UI)
// ─────────────────────────────────────────
async function testAiProviderConnection(aiConfig, companyId) {
    const startMs = Date.now();
    try {
        const result = await callAiProvider('Reply with exactly: OK', aiConfig, { temperature: 0.0, maxTokens: 10 }, companyId);
        const latencyMs = Date.now() - startMs;
        return {
            success: true,
            message: `Connection successful (${latencyMs}ms)${result.content ? ` — "${result.content.substring(0, 40)}"` : ''}`,
            model: aiConfig.model,
            provider: aiConfig.provider,
            latencyMs,
        };
    }
    catch (error) {
        const url = aiConfig.baseUrl || (aiConfig.provider === 'glm' ? constants_1.GLM_API_URL : '');
        const errorMsg = error?.response?.data?.error?.message || error?.response?.data?.message || error.message || 'Connection failed';
        return {
            success: false,
            message: `${errorMsg} (Endpoint: ${url}, Model: ${aiConfig.model})`,
            model: aiConfig.model,
            provider: aiConfig.provider,
        };
    }
}
// ─────────────────────────────────────────
// JSON cleanup
// ─────────────────────────────────────────
function cleanupJsonResponse(content) {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch)
        return jsonMatch[0];
    let cleaned = content.trim();
    if (cleaned.startsWith('```json'))
        cleaned = cleaned.substring(7);
    else if (cleaned.startsWith('```'))
        cleaned = cleaned.substring(3);
    if (cleaned.endsWith('```'))
        cleaned = cleaned.substring(0, cleaned.length - 3);
    return cleaned.trim();
}
// ─────────────────────────────────────────
// Prompt Logging
// ─────────────────────────────────────────
async function logPromptExecution(stage, input, output, model, context) {
    const db = admin.firestore();
    try {
        await db.collection('promptLogs').add({
            stage,
            companyId: context?.companyId || null,
            pipelineRunId: context?.pipelineRunId || null,
            promptVersion: context?.promptVersion || 'runtime',
            prompt: context?.prompt?.substring(0, 10000) || null,
            input: JSON.stringify(input).substring(0, 5000),
            output: output.substring(0, 10000),
            model,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    }
    catch {
        // non-critical
    }
}
// ─────────────────────────────────────────
// Relevance Check
// ─────────────────────────────────────────
async function checkRelevance(article, aiConfig, context) {
    const prompt = `${aiConfig.relevancePrompt || DEFAULT_RELEVANCE_PROMPT}

Title: ${article.title}
Content: ${article.content.substring(0, 2000)}
Source: ${article.source}

Decision:`;
    try {
        const result = await callAiProvider(prompt, aiConfig, { temperature: 0.1, maxTokens: 120 }, context?.companyId);
        const relevantMatch = result.content.match(/RELEVANT:\s*(YES|NO)/i);
        const confidenceMatch = result.content.match(/CONFIDENCE:\s*(\d+\.?\d*)/i);
        const reasonMatch = result.content.match(/REASON:\s*(.+)/i);
        const isRelevant = relevantMatch ? relevantMatch[1].toUpperCase() === 'YES' : false;
        const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : (isRelevant ? 0.5 : 0);
        const reason = reasonMatch ? reasonMatch[1].trim() : (isRelevant ? 'Relevant' : 'Not relevant');
        const normalizedConfidence = Math.min(1, Math.max(0, confidence));
        await logPromptExecution('relevance-check', { title: article.title, source: article.source }, result.content, aiConfig.model, { ...context, prompt });
        trackAiCost('relevance-check', result.usage, aiConfig.model, aiConfig.provider, context?.companyId, context?.pipelineRunId).catch(() => { });
        return { isRelevant, confidence: normalizedConfidence, reason };
    }
    catch (error) {
        console.error('Error calling AI API for relevance check:', error);
        return { isRelevant: false, confidence: 0, reason: `API error: ${error instanceof Error ? error.message : 'Unknown error'}` };
    }
}
// ─────────────────────────────────────────
// Article Analysis
// ─────────────────────────────────────────
async function analyzeArticle(article, aiConfig, context) {
    const prompt = `${aiConfig.analysisPrompt || DEFAULT_ANALYSIS_PROMPT}

Article title: ${article.title}
Source: ${article.source}
Published at: ${article.publishedAt}
URL: ${article.url}
Article body:
${article.content}`;
    const result = await callAiProvider(prompt, aiConfig, { temperature: 0.3 }, context?.companyId);
    const content = cleanupJsonResponse(result.content);
    await logPromptExecution('deep-analysis', { title: article.title, source: article.source, url: article.url }, content, aiConfig.model, { ...context, prompt });
    trackAiCost('deep-analysis', result.usage, aiConfig.model, aiConfig.provider, context?.companyId, context?.pipelineRunId).catch(() => { });
    return JSON.parse(content);
}
// ─────────────────────────────────────────
// Batch: Relevance Filtering
// ─────────────────────────────────────────
async function processRelevanceFiltering(options) {
    const db = admin.firestore();
    const baseBatchSize = options?.aiConfig.maxPendingBatch || 20;
    let queryRef = db.collection('articles').where('status', '==', 'pending');
    if (options?.companyId)
        queryRef = queryRef.where('companyId', '==', options.companyId);
    if (options?.pipelineRunId)
        queryRef = queryRef.where('pipelineRunId', '==', options.pipelineRunId);
    const pendingArticlesSnapshot = await queryRef.limit(getDynamicBatchSize(baseBatchSize)).get();
    if (pendingArticlesSnapshot.empty)
        return { success: true, processed: 0, passed: 0 };
    let processed = 0;
    let passed = 0;
    const batch = db.batch();
    for (const doc of pendingArticlesSnapshot.docs) {
        const article = doc.data();
        try {
            const result = await checkRelevance({ title: article.title, content: article.content, source: article.source }, options.aiConfig, { companyId: article.companyId || options?.companyId, pipelineRunId: article.pipelineRunId || options?.pipelineRunId });
            batch.update(doc.ref, {
                status: result.isRelevant ? 'filtered' : 'rejected',
                filteredAt: admin.firestore.FieldValue.serverTimestamp(),
                relevanceScore: result.confidence,
                relevanceReason: result.reason,
            });
            processed++;
            if (result.isRelevant)
                passed++;
            await new Promise(resolve => setTimeout(resolve, getRateLimitDelay(0)));
        }
        catch (error) {
            console.error(`Failed to filter article ${doc.id}:`, error);
            recordError();
        }
    }
    if (processed > 0)
        await batch.commit();
    return { success: true, processed, passed };
}
// ─────────────────────────────────────────
// Batch: Deep Analysis
// ─────────────────────────────────────────
async function processDeepAnalysis(options) {
    const db = admin.firestore();
    const baseBatchSize = options?.aiConfig.maxAnalysisBatch || 10;
    let queryRef = db.collection('articles').where('status', '==', 'filtered');
    if (options?.companyId)
        queryRef = queryRef.where('companyId', '==', options.companyId);
    if (options?.pipelineRunId)
        queryRef = queryRef.where('pipelineRunId', '==', options.pipelineRunId);
    const filteredArticlesSnapshot = await queryRef.limit(getDynamicBatchSize(baseBatchSize)).get();
    if (filteredArticlesSnapshot.empty)
        return { success: true, processed: 0 };
    let processed = 0;
    const batch = db.batch();
    for (const doc of filteredArticlesSnapshot.docs) {
        const article = doc.data();
        try {
            const publishedAtStr = article.publishedAt
                ? (article.publishedAt.toDate ? article.publishedAt.toDate().toISOString() : new Date(article.publishedAt).toISOString())
                : new Date().toISOString();
            const analysisResult = await analyzeArticle({ title: article.title, content: article.content, source: article.source, url: article.url, publishedAt: publishedAtStr }, options.aiConfig, { companyId: article.companyId || options?.companyId, pipelineRunId: article.pipelineRunId || options?.pipelineRunId });
            batch.update(doc.ref, {
                status: 'analyzed',
                analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
                summary: analysisResult.summary || [],
                category: analysisResult.category || 'other',
                companies: analysisResult.companies || { acquiror: null, target: null, financialSponsor: null },
                deal: analysisResult.deal || { type: 'other', amount: 'undisclosed', stake: null },
                insights: analysisResult.insights || null,
                tags: analysisResult.tags || [],
            });
            processed++;
            await new Promise(resolve => setTimeout(resolve, getRateLimitDelay(0)));
        }
        catch (error) {
            console.error(`Failed to analyze article ${doc.id}:`, error);
            recordError();
        }
    }
    if (processed > 0)
        await batch.commit();
    return { success: true, processed };
}
//# sourceMappingURL=aiService.js.map