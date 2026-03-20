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
  } else {
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
  let queryRef: FirebaseFirestore.Query = db.collection('articles')
    .where('status', '==', 'analyzed')
    .where('companyId', '==', options.companyId);

  if (options.pipelineRunId) {
    queryRef = queryRef.where('pipelineRunId', '==', options.pipelineRunId);
  }

  const articlesSnapshot = await queryRef.get();
  const articles: any[] = articlesSnapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));

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
