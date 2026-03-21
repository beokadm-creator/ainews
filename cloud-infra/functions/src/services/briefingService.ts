import * as admin from 'firebase-admin';
import { callAiProvider, logPromptExecution } from './aiService';
import { RuntimeAiConfig, RuntimeOutputConfig } from '../types/runtime';

interface OutputGenerationOptions {
  companyId: string;
  pipelineRunId?: string;
  aiConfig: RuntimeAiConfig;
  outputConfig: RuntimeOutputConfig;
  timezone?: string;
}

function buildArticleDigest(articles: any[], includeArticleBody: boolean): string {
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


function normalizeOutputPayload(type: RuntimeOutputConfig['type'], raw: string, articles: any[]) {
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
    } catch {
      return { type, text: raw, structured: null };
    }
  }

  return { type, text: raw, structured: null };
}

export async function generatePipelineOutput(
  articles: any[],
  options: OutputGenerationOptions
) {
  const db = admin.firestore();
  const outputType = options.outputConfig.type;

  if (articles.length === 0) {
    // [FIX] 기사가 없더라도 빈 리포트를 생성하여 '실패'로 보이지 않게 함
    const outputRef = db.collection('outputs').doc();
    const title = options.outputConfig.title || 'AI News Output';
    await outputRef.set({
      id: outputRef.id,
      companyId: options.companyId,
      pipelineRunId: options.pipelineRunId || null,
      type: outputType,
      title: title,
      articleIds: [],
      articleCount: 0,
      rawOutput: "현재 해당 조건(키워드 및 기간)에 부합하는 분석된 기사가 없습니다. 수집 기간을 늘리거나 키워드를 조정해 보시기 바랍니다.",
      structuredOutput: {
        title: title,
        summary: "현재 데이터베이스에 해당 조건으로 분석 완료된 기사가 존재하지 않습니다. 시스템이 기사를 수집 중이거나, AI 필터링 단계에서 적합한 기사를 찾지 못했을 수 있습니다.",
        highlights: [],
        trends: [],
        themes: [],
        risks: [],
        opportunities: [],
        nextSteps: ["수집 기간(7일 등)을 늘려보세요.", "검색 키워드를 더 일반적인 단어로 조정해 보세요.", "매체 구독 설정을 확인해 보세요."]
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      success: true,
      outputId: outputRef.id,
      outputType,
      articleCount: 0
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
  } else {
    const basePrompt = outputType === 'custom_prompt'
      ? (options.outputConfig.prompt || options.aiConfig.outputPrompt || 'Analyze the following articles and return the requested output.')
      : (options.aiConfig.outputPrompt || `You are an expert investment analyst preparing a premium executive report.
Analyze the provided articles and generate a structured report in **Korean (한국어)**. 
For key professional terms or corporate names, you may include English in parentheses if it aids clarity.

Return a JSON object with this shape:
{
  "title": "Report Title (In Korean)",
  "summary": "Executive summary (In Korean, 3-5 sentences)",
  "highlights": [
    { 
      "title": "Highlight title", 
      "description": "Insightful description. Mention the specific deal or event.", 
      "articleIndex": 1 
    }
  ],
  "trends": [
    {
      "topic": "Current trend identified from the news",
      "description": "Detailed explanation of the trend and its impact (In Korean)",
      "relatedArticles": [1, 2]
    }
  ],
  "themes": [
    { "name": "Broad theme (e.g., M&A Surge)", "description": "Theme description" }
  ],
  "risks": ["Risk factor 1", "Risk factor 2"],
  "opportunities": ["Opportunity 1", "Opportunity 2"],
  "nextSteps": ["Actionable recommendation 1", "Recommendation 2"]
}

Important:
- Use a professional, insightful tone.
- Reference the 'articleIndex' accurately in highlights and trends.
- The report must be predominantly in Korean.`);

    prompt = `${basePrompt}

[CRITICAL INSTRUCTION: TRANSLATION]
You MUST generate the ENTIRE report (all titles, descriptions, trends, categories, and tags) in completely natural Korean (한국어). 
Do NOT output English sentences unless you are citing proper nouns (e.g. "Apple Inc. (애플)"). This system is for Korean users and any un-translated English output will be considered a total failure.

Company: ${options.companyId}
Output title: ${options.outputConfig.title || 'AI News Output'}
Article digest:
${digest}`;

    const response = await callAiProvider(prompt, options.aiConfig, { temperature: 0.3 }, options.companyId);
    rawOutput = response.content;

    await logPromptExecution(
      outputType === 'custom_prompt' ? 'custom-output' : 'daily-briefing',
      { articleCount: limitedArticles.length, outputType },
      rawOutput,
      options.aiConfig.model,
      {
        companyId: options.companyId,
        pipelineRunId: options.pipelineRunId,
        prompt
      }
    );
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

export async function createDailyBriefing(options?: OutputGenerationOptions) {
  if (!options) {
    throw new Error('createDailyBriefing now requires runtime options');
  }

  const db = admin.firestore();
  
  // [FIX] 특정 파이프라인 런에 국한되지 않고, 해당 회사의 '분석 완료'된 모든 최신 기사를 대상으로 함.
  // 사용자가 수집을 돌렸을 때 기존에 있던 좋은 기사들도 리포트에 포함되어야 풍성함.
  let queryRef = db.collection('articles')
    .where('companyId', '==', options.companyId)
    .where('status', '==', 'analyzed')
    .orderBy('analyzedAt', 'desc')
    .limit(50);

  const articlesSnapshot = await queryRef.get();
  const articles: any[] = articlesSnapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));

  // 관련성 점수 높은 순으로 정렬하여 리포트 생성
  const sorted = [...articles].sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
  return generatePipelineOutput(sorted, options);
}

export async function saveBriefingVersion(
  outputId: string,
  updatedData: Record<string, any>,
  changeType: 'edited' | 'approved' | 'regenerated' = 'edited'
): Promise<void> {
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
