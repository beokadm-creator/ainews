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
