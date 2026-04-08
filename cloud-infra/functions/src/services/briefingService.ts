import * as admin from 'firebase-admin';
import { callAiProvider, logPromptExecution, resolveAiCallOptions, trackAiCost } from './aiService';
import { PROVIDER_DEFAULTS, RuntimeAiConfig, RuntimeOutputConfig } from '../types/runtime';
import { cleanHtmlContent, fixEncodingIssues } from '../utils/encodingUtils';

interface OutputGenerationOptions {
  companyId: string;
  pipelineRunId?: string;
  aiConfig: RuntimeAiConfig;
  outputConfig: RuntimeOutputConfig;
  timezone?: string;
}

function stripMarkdownCodeFence(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
  if (!fenceMatch) {
    return trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```$/, '').trim();
  }

  return fenceMatch[1].trim();
}

function extractHtmlPayload(raw: string): string {
  const cleaned = stripMarkdownCodeFence(raw || '').trim();
  const doctypeIdx = cleaned.search(/<!doctype\s+html/i);
  if (doctypeIdx >= 0) {
    return cleaned.slice(doctypeIdx).trim();
  }
  const htmlIdx = cleaned.search(/<html[\s>]/i);
  if (htmlIdx >= 0) {
    return cleaned.slice(htmlIdx).trim();
  }
  return cleaned;
}

function ensureHtmlDocument(raw: string, title: string) {
  const cleaned = extractHtmlPayload(raw || '');
  const hasHtmlTag = /<html[\s>]|<body[\s>]|<article[\s>]|<section[\s>]|<div[\s>]/i.test(cleaned);
  if (hasHtmlTag) return cleaned;

  const paragraphs = cleaned
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `<p>${item}</p>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin: 0; background: linear-gradient(180deg, #f4f7fb 0%, #e9eef5 100%); color: #102033; font-family: "Noto Sans KR Variable", "Malgun Gothic", sans-serif; }
    .report-content { max-width: 940px; margin: 40px auto; padding: 0 20px 40px; }
    .report-header { padding: 36px 40px; border-radius: 28px; background: linear-gradient(135deg, #0f2238 0%, #1f4b74 100%); color: #f8fafc; box-shadow: 0 18px 50px rgba(15, 34, 56, 0.18); }
    .report-header h1 { margin: 0; font-size: 34px; line-height: 1.25; color: #f2d27b; }
    .section-summary { margin-top: 24px; padding: 28px 32px; border: 1px solid #d8e1ec; border-radius: 24px; background: rgba(255, 255, 255, 0.92); box-shadow: 0 12px 30px rgba(15, 23, 42, 0.06); }
    .section-summary h2 { margin: 0 0 16px; font-size: 20px; color: #16324f; }
    .section-summary p { margin: 0 0 14px; font-size: 15px; line-height: 1.85; color: #334155; }
  </style>
</head>
<body>
  <article class="report-content">
    <header class="report-header"><h1>${title}</h1></header>
    <section class="section-summary">
      <h2>Executive Summary</h2>
      ${paragraphs || '<p>Report content was not generated.</p>'}
    </section>
  </article>
</body>
  </html>`;
}

async function resolveCompanyDisplayName(companyId: string) {
  try {
    const db = admin.firestore();
    const settingsDoc = await db.collection('companySettings').doc(companyId).get();
    const settings = settingsDoc.data() as any;
    const fromSettings = `${settings?.branding?.publisherName || settings?.companyName || ''}`.trim();
    if (fromSettings) return fromSettings;

    const companyDoc = await db.collection('companies').doc(companyId).get();
    const companyData = companyDoc.data() as any;
    const fromCompany = `${companyData?.name || companyData?.displayName || ''}`.trim();
    if (fromCompany) return fromCompany;
  } catch {
    // fallback below
  }
  return 'EUM Private Equity';
}

function resolveCustomReportAiConfig(aiConfig: RuntimeAiConfig): RuntimeAiConfig {
  return {
    ...aiConfig,
    provider: 'glm',
    model: 'glm-4.7',
    apiKeyEnvKey: PROVIDER_DEFAULTS.glm.apiKeyEnvKey,
    filteringModel: 'glm-4.7',
    fallbackProvider: undefined,
    fallbackModel: undefined,
  };
}

// digest에 실제로 사용된 기사 순서(정렬 후)를 반환 — 각주 번호가 이 순서와 일치해야 함
function prioritizeArticlesForDigest(articles: any[]): any[] {
  return [...articles]
    .sort((a, b) => {
      const scoreGap = Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0);
      if (scoreGap !== 0) return scoreGap;
      const analyzedGap = Number(Boolean(b.summary?.length || b.category || b.tags?.length)) - Number(Boolean(a.summary?.length || a.category || a.tags?.length));
      if (analyzedGap !== 0) return analyzedGap;
      const timeA = a.publishedAt?.toDate ? a.publishedAt.toDate().getTime() : new Date(a.publishedAt || 0).getTime();
      const timeB = b.publishedAt?.toDate ? b.publishedAt.toDate().getTime() : new Date(b.publishedAt || 0).getTime();
      return timeB - timeA;
    })
    .slice(0, 100);
}

function buildCustomReportArticleDigest(articles: any[]): { digest: string; orderedArticles: any[] } {
  const prioritized = prioritizeArticlesForDigest(articles);

  const digest = prioritized.map((article, index) => {
    const pub = article.publishedAt?.toDate
      ? article.publishedAt.toDate().toLocaleDateString('ko-KR')
      : (article.publishedAt || '');
    const safeTitle = fixEncodingIssues(cleanHtmlContent(article.title || ''));
    const safeSource = fixEncodingIssues(cleanHtmlContent(article.source || ''));
    const safeBody = fixEncodingIssues(cleanHtmlContent(article.content || (article.summary || []).join(' ')));
    const safeSummary = Array.isArray(article.summary) ? article.summary.slice(0, 3).join(' / ') : '';
    return [
      `[ARTICLE ${index + 1}]`,
      `TITLE: ${safeTitle}`,
      `URL: ${article.url || ''}`,
      `SOURCE: ${safeSource}`,
      `DATE: ${pub}`,
      `RELEVANCE_SCORE: ${article.relevanceScore || 0}/100`,
      `CATEGORY: ${article.category || 'uncategorized'}`,
      `SUMMARY: ${safeSummary || 'No summary available'}`,
      'BODY:',
      safeBody.substring(0, 2200),
    ].join('\n');
  }).join('\n\n---\n\n');

  return { digest, orderedArticles: prioritized };
}

function buildArticleDigest(articles: any[], includeArticleBody: boolean): string {
  return articles.map((article, index) => {
    const safeTitle = fixEncodingIssues(cleanHtmlContent(article.title || ''));
    const safeSource = fixEncodingIssues(cleanHtmlContent(article.source || ''));
    const safeSummary = (article.summary || []).map((line: string) => fixEncodingIssues(cleanHtmlContent(line || '')));
    const safeContent = fixEncodingIssues(cleanHtmlContent(article.content || ''));
    const parts = [
      `[${index + 1}] ${safeTitle}`,
      `Source: ${safeSource}`,
      `PublishedAt: ${article.publishedAt?.toDate ? article.publishedAt.toDate().toISOString() : article.publishedAt || ''}`,
      `Category: ${article.category || 'other'}`,
      `RelevanceScore: ${article.relevanceScore || 0}`,
      `Summary: ${safeSummary.join(' ')}`,
      `DealAmount: ${article.deal?.amount || 'undisclosed'}`,
      `Tags: ${(article.tags || []).join(', ')}`
    ];

    if (includeArticleBody) {
      parts.push(`Body: ${safeContent.substring(0, 4000)}`);
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
  const reportAiConfig = resolveCustomReportAiConfig(options.aiConfig);

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

  const limitedArticles = articles.slice(0, options.outputConfig.maxArticles || 100);
  const digest = buildArticleDigest(limitedArticles, !!options.outputConfig.includeArticleBody);

  let prompt = '';
  let rawOutput = '';

  if (outputType === 'article_list') {
    // ★ article_list도 AI로 전체 요약 생성
    const listSummaryPrompt = `당신은 M&A·사모펀드·전략적 투자 분야의 전문 애널리스트입니다.
아래 기사 목록을 분석하여 전체 요약을 작성하세요.

모든 텍스트는 반드시 자연스러운 한국어로 작성하세요.

아래 JSON 형식으로만 반환하세요 (다른 텍스트 없이):
{
  "title": "기사 요약 제목",
  "summary": "전체 기사 요약 (3~5문장, 핵심 딜 및 시장 동향 포함)",
  "keyThemes": ["주요 테마 1", "주요 테마 2"],
  "notableDeals": ["주요 딜 요약 1", "주요 딜 요약 2"]
}

작성 원칙:
- 기사 번호를 참조하여 핵심 내용을 요약하세요.
- 보고서 전체를 100% 한국어로 작성하세요.

Article digest:
${digest}`;

    const aiResponse = await callAiProvider(
      listSummaryPrompt,
      options.aiConfig,
      resolveAiCallOptions(options.aiConfig.provider, 'article-list-summary'),
      options.companyId,
    );
    rawOutput = aiResponse.content;
    await trackAiCost('article-list-summary', aiResponse.usage, aiResponse.model, aiResponse.provider, options.companyId, options.pipelineRunId);

    await logPromptExecution(
      'article-list-summary',
      { articleCount: limitedArticles.length, outputType },
      rawOutput,
      aiResponse.model,
      {
        companyId: options.companyId,
        pipelineRunId: options.pipelineRunId,
        prompt: listSummaryPrompt,
      }
    );
  } else {
    const basePrompt = outputType === 'custom_prompt'
      ? (options.outputConfig.prompt || reportAiConfig.outputPrompt || 'Analyze the following articles and return the requested output.')
      : (reportAiConfig.outputPrompt || `당신은 M&A·사모펀드·전략적 투자 분야의 전문 투자 애널리스트입니다.
제공된 기사들을 분석하여 구조화된 프리미엄 투자 인텔리전스 보고서를 작성하세요.

모든 텍스트는 반드시 자연스러운 한국어로 작성하세요.
기업명·펀드명 등 고유명사는 한국어 표기를 우선하되, 필요 시 영문을 괄호로 병기하세요. (예: 카카오(Kakao))

아래 JSON 형식으로만 반환하세요 (다른 텍스트 없이):
{
  "title": "보고서 제목",
  "summary": "전체 요약 (3~5문장, 핵심 딜 및 시장 동향 포함)",
  "highlights": [
    {
      "title": "주요 딜/이슈 제목",
      "description": "구체적인 딜 내용과 시사점을 서술하세요.",
      "articleIndex": 1
    }
  ],
  "trends": [
    {
      "topic": "식별된 시장 트렌드",
      "description": "트렌드의 배경, 원인, 시장 영향을 상세히 서술하세요.",
      "relatedArticles": [1, 2]
    }
  ],
  "themes": [
    { "name": "주요 테마 (예: M&A 급증)", "description": "테마에 대한 분석" }
  ],
  "risks": ["리스크 요인 1", "리스크 요인 2"],
  "opportunities": ["투자 기회 1", "투자 기회 2"],
  "nextSteps": ["실행 가능한 제언 1", "제언 2"]
}

작성 원칙:
- 전문적이고 통찰력 있는 어조를 유지하세요.
- highlights와 trends의 'articleIndex'는 기사 번호와 정확히 일치해야 합니다.
- 보고서 전체를 100% 한국어로 작성하세요.`);

    prompt = `${basePrompt}

[필수 지시사항]
보고서의 모든 내용(제목, 요약, 트렌드, 태그 포함)을 반드시 자연스러운 한국어로 작성하세요.
영어 문장은 절대 출력하지 마세요. 고유명사(기업명, 펀드명)는 한국어 표기 후 필요 시 영문 병기.

Company: ${options.companyId}
Output title: ${options.outputConfig.title || 'AI News Output'}
Article digest:
${digest}`;

    const response = await callAiProvider(
      prompt,
      reportAiConfig,
      resolveAiCallOptions(reportAiConfig.provider, 'daily-briefing'),
      options.companyId,
    );
    rawOutput = response.content;
    await trackAiCost(outputType === 'custom_prompt' ? 'custom-output' : 'daily-briefing', response.usage, response.model, response.provider, options.companyId, options.pipelineRunId);

    await logPromptExecution(
      outputType === 'custom_prompt' ? 'custom-output' : 'daily-briefing',
      { articleCount: limitedArticles.length, outputType },
      rawOutput,
      response.model,
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
    .limit(100);

  const articlesSnapshot = await queryRef.get();
  const articles: any[] = articlesSnapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));

  // 관련성 점수 높은 순으로 정렬하여 리포트 생성
  const sorted = [...articles].sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
  return generatePipelineOutput(sorted, options);
}

// ─────────────────────────────────────────
// generateCustomReport: 사용자가 선택한 기사 + 키워드 + 방향 프롬프트 → HTML 보고서
// ─────────────────────────────────────────
export interface CustomReportOptions {
  companyId: string;
  articleIds: string[];
  keywords: string[];
  analysisPrompt: string;
  savedPrompt?: string; // if set, stored in Firestore instead of analysisPrompt
  reportTitle?: string;
  volNumber?: number;
  requestedBy: string;
  aiConfig: RuntimeAiConfig;
  outputId?: string;
  outputMetadata?: Record<string, any>;
  structureGuide?: string | null; // heading structure extracted from a style template output
}

export async function generateCustomReport(options: CustomReportOptions) {
  const db = admin.firestore();

  const articleDocs = await Promise.all(
    options.articleIds.map((id) => db.collection('articles').doc(id).get())
  );
  const articles = articleDocs
    .filter((doc) => doc.exists)
    .map((doc) => ({ id: doc.id, ...(doc.data() as any) }));

  if (articles.length === 0) {
    throw new Error('No selected articles were found.');
  }

  // digest와 함께 GLM에 전달된 실제 기사 순서를 받아옴
  // → 각주 [1],[2],...가 이 순서의 기사를 가리킴
  const { digest: articleDigest, orderedArticles } = buildCustomReportArticleDigest(articles);
  const reportAiConfig = resolveCustomReportAiConfig(options.aiConfig);
  const companyDisplayName = await resolveCompanyDisplayName(options.companyId);
  const keywordSummary = options.keywords.length > 0 ? options.keywords.join(', ') : 'deal flow, investment, portfolio, private equity';
  const reportTitle = options.reportTitle || `${companyDisplayName} Market Intelligence Report`;
  const volNumber = options.volNumber || 1;

const systemPrompt = `You are a senior private equity analyst.
Output a complete HTML report in Korean for investment professionals.

Universal Requirements (always apply):
1. Output a COMPLETE HTML document: <!DOCTYPE html> through </html>, with <head> containing <meta charset="UTF-8"> and embedded <style>.
2. LIGHT MODE ONLY — white background (#ffffff), dark body text (#111827 or #1f2937). NEVER use white or light-colored text. Do NOT include dark mode CSS or @media (prefers-color-scheme: dark).
3. All headings, labels, and body text must be in Korean. Exception: proper nouns, company names, and financial abbreviations (M&A, PE, IPO, GP, LP, etc.).
4. Do NOT include footnote reference numbers like [1], [2], [3] anywhere in the report body.
5. Part/section numbers must be strictly sequential starting from 1.
6. REQUIRED HTML structure for each article analysis block — use EXACTLY these class names:
   <div class="article-block">
     <div class="article-sector">[sector tag]</div>
     <div class="article-title"><a href="[URL field from ARTICLE N]">[title]</a></div>
     [analysis content paragraphs]
   </div>
7. REQUIRED HTML structure for the reference table at the end:
   <table class="ref-table">
     <thead><tr><th>번호</th><th>날짜</th><th>헤드라인</th><th>매체</th></tr></thead>
     <tbody>
       <tr><td>1</td><td>[date]</td><td>[headline]</td><td>[source]</td></tr>
     </tbody>
   </table>
   Use the exact integer (1, 2, 3 …) from the ARTICLE number in the 번호 column.
   For the href in each article-block title link, use the URL field provided in the ARTICLE digest.

[ANALYSIS INSTRUCTIONS — HIGHEST PRIORITY]
Follow the instructions below EXACTLY. They define the structure, format, tone, and content scope. Override any default behavior above if there is conflict.

${options.analysisPrompt || 'Focus on market structure, deal meaning, buyer and seller implications, and PE relevance.'}${options.structureGuide ? `\n\n${options.structureGuide}` : ''}`;

  const userPrompt = `Report title: ${reportTitle}
Company: ${companyDisplayName}
Priority keywords: ${keywordSummary}
Selected article count: ${articles.length}
Use at most the strongest 100 articles already curated below.

Article digest:
${articleDigest}`;

  const response = await callAiProvider(
    `${systemPrompt}\n\n${userPrompt}`,
    reportAiConfig,
    resolveAiCallOptions(reportAiConfig.provider, 'custom-report', { maxTokens: 32000, temperature: 0.4 }),
    options.companyId
  );
  await trackAiCost('custom-output', response.usage, response.model, response.provider, options.companyId);

  const htmlContent = ensureHtmlDocument(response.content, reportTitle);

  const outputRef = options.outputId
    ? db.collection('outputs').doc(options.outputId)
    : db.collection('outputs').doc();
  await outputRef.set({
    id: outputRef.id,
    companyId: options.companyId,
    type: 'custom_report',
    title: reportTitle,
    volNumber,
    keywords: options.keywords,
    analysisPrompt: options.savedPrompt !== undefined ? options.savedPrompt : options.analysisPrompt,
    articleIds: options.articleIds,
    // GLM에 전달된 실제 기사 순서 (각주 [1],[2],... 와 1:1 대응)
    // 프론트엔드는 articleIds 대신 orderedArticleIds로 참조 목록 표시해야 함
    orderedArticleIds: orderedArticles.map((a: any) => a.id),
    articleCount: articles.length,
    digestArticleCount: orderedArticles.length,
    htmlContent,
    rawOutput: htmlContent,
    structuredOutput: null,
    requestedBy: options.requestedBy,
    status: 'completed',
    generatedOutputId: null,
    parentRequestId: null,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(options.outputMetadata || {}),
    ...(!options.outputId ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
  }, { merge: true });

  await logPromptExecution(
    'custom-output',
    { articleCount: articles.length, keywords: options.keywords },
    htmlContent,
    response.model,
    { companyId: options.companyId, prompt: userPrompt }
  );

  return {
    success: true,
    outputId: outputRef.id,
    articleCount: articles.length,
  };
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
