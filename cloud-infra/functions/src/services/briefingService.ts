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

    const aiResponse = await callAiProvider(listSummaryPrompt, options.aiConfig, { temperature: 0.3 }, options.companyId);
    rawOutput = aiResponse.content;

    await logPromptExecution(
      'article-list-summary',
      { articleCount: limitedArticles.length, outputType },
      rawOutput,
      options.aiConfig.model,
      {
        companyId: options.companyId,
        pipelineRunId: options.pipelineRunId,
        prompt: listSummaryPrompt,
      }
    );
  } else {
    const basePrompt = outputType === 'custom_prompt'
      ? (options.outputConfig.prompt || options.aiConfig.outputPrompt || 'Analyze the following articles and return the requested output.')
      : (options.aiConfig.outputPrompt || `당신은 M&A·사모펀드·전략적 투자 분야의 전문 투자 애널리스트입니다.
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

// ─────────────────────────────────────────
// generateCustomReport: 사용자가 선택한 기사 + 키워드 + 방향 프롬프트 → HTML 보고서
// ─────────────────────────────────────────
export interface CustomReportOptions {
  companyId: string;
  articleIds: string[];
  keywords: string[];
  analysisPrompt: string;
  reportTitle?: string;
  requestedBy: string;
  aiConfig: RuntimeAiConfig;
}

export async function generateCustomReport(options: CustomReportOptions) {
  const db = admin.firestore();

  // 1. 선택한 기사들 로드
  const articleDocs = await Promise.all(
    options.articleIds.map(id => db.collection('articles').doc(id).get())
  );
  const articles = articleDocs
    .filter(d => d.exists)
    .map(d => ({ id: d.id, ...d.data() as any }));

  if (articles.length === 0) {
    throw new Error('선택한 기사를 찾을 수 없습니다.');
  }

  // 2. 기사 원문 digest 구성 (번호 포함)
  const articleDigest = articles.map((article, index) => {
    const pub = article.publishedAt?.toDate
      ? article.publishedAt.toDate().toLocaleDateString('ko-KR')
      : (article.publishedAt || '');
    return [
      `[기사 ${index + 1}]`,
      `제목: ${article.title}`,
      `매체: ${article.source || ''}`,
      `날짜: ${pub}`,
      `원문:\n${(article.content || (article.summary || []).join(' ')).substring(0, 3000)}`,
    ].join('\n');
  }).join('\n\n---\n\n');

  const keywordsText = options.keywords.length > 0
    ? `분석 초점 키워드: ${options.keywords.join(', ')}`
    : '';

  const reportTitle = options.reportTitle || `${options.keywords[0] || '시장'} 동향 분석 보고서`;

  // 3. AI 프롬프트 구성
  const systemPrompt = `당신은 국내 최고 수준의 투자·산업 분석 전문가입니다.
제공된 기사들을 바탕으로 전문적인 분석 보고서를 HTML 형식으로 작성하세요.

[분석 및 정제 원칙]
1. 원문 정제: 기사 원문에 포함된 '좋아요', '댓글', '공유하기', '글자크기 조절', '로그인' 등 기사 내용과 관련 없는 사이트 UI 텍스트는 분석에서 반드시 무시하고 제거하세요.
2. 언어: 모든 분석 내용(제목, 본문, 요약, 트렌드 등)은 반드시 자연스러운 한국어로 작성하세요.
3. 통찰력: 단순한 기사 요약을 넘어, 각 이슈가 향후 시장이나 관련 기업에 미칠 영향(So-what)을 전문적으로 분석하세요.
4. 각주 표시: 분석 근거가 되는 기사는 반드시 <sup><a class="footnote-ref" data-ref="N">[N]</a></sup> 형식으로 표시하세요. (N은 기사 번호)
5. 구조: <!DOCTYPE html>부터 </html>까지 완전한 HTML 구조를 유지하되, 세련된 투자 인텔리전스 보고서 형식을 갖추세요.

보고서 HTML 권장 구조:
<article class="report-content">
  <header class="report-header"><h1>[주제] 분석 보고서</h1></header>
  <section class="section-summary"><h2>핵심 요약</h2><p>전문가적인 요약 세 문장 내외</p></section>
  <section class="section-highlights"><h2>주요 이슈 및 딜 분석</h2><!-- 카드 형태의 구조화된 분석 --></section>
  <section class="section-trends"><h2>시장 동향 및 거시적 시사점</h2></section>
  <section class="section-risks"><h2>리스크 & 기회요인</h2></section>
  <section class="section-outlook"><h2>향후 전망 및 전략적 제언</h2></section>
  <section class="section-references"><h2>참고 자료</h2><!-- 각 기사 출처 및 링크 명시 --></section>
</article>`;

  const userPrompt = `${keywordsText}
${options.analysisPrompt ? `분석 방향: ${options.analysisPrompt}` : ''}
보고서 제목: ${reportTitle}

아래 ${articles.length}개의 기사를 분석하여 전문 보고서를 HTML로 작성하세요.

${articleDigest}`;

  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;
  const response = await callAiProvider(
    fullPrompt,
    options.aiConfig,
    { temperature: 0.3, maxTokens: 8000 },
    options.companyId
  );

  const htmlContent = response.content;

  // 4. outputs 컬렉션에 저장
  const outputRef = db.collection('outputs').doc();
  await outputRef.set({
    id: outputRef.id,
    companyId: options.companyId,
    type: 'custom_report',
    title: reportTitle,
    keywords: options.keywords,
    analysisPrompt: options.analysisPrompt,
    articleIds: options.articleIds,
    articleCount: articles.length,
    htmlContent,
    rawOutput: htmlContent,
    structuredOutput: null,
    requestedBy: options.requestedBy,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await logPromptExecution(
    'custom-output',
    { articleCount: articles.length, keywords: options.keywords },
    htmlContent,
    options.aiConfig.model,
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
