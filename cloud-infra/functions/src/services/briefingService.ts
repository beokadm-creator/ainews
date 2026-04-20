import * as admin from 'firebase-admin';
import { load as cheerioLoad } from 'cheerio';
import { callAiProvider, logPromptExecution, resolveAiCallOptions, trackAiCost } from './aiService';
import { PROVIDER_DEFAULTS, RuntimeAiConfig, RuntimeOutputConfig } from '../types/runtime';
import { cleanHtmlContent, fixEncodingIssues } from '../utils/encodingUtils';
import { calculateTokenSimilarity } from './duplicateService';
import { buildSafePrompt, parseAiJsonResponse } from '../utils/aiHelpers';

export function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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
    
  const safeTitle = escapeHtml(title);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
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
    <header class="report-header"><h1>${safeTitle}</h1></header>
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

/**
 * AI가 생성한 HTML에 data-article-id를 영구 삽입하여 Firestore에 저장.
 * 클라이언트에서 배열 순서에 의존하지 않고 ID로 직접 조회 가능하게 함.
 *
 * - article-block 원문 보기 버튼: href URL → orderedArticles URL 매칭으로 ID 결정
 * - ref-table 헤드라인 버튼: 번호 컬럼(1-based) → orderedArticles[N-1].id
 *   (AI가 원래 ARTICLE N 번호를 유지하면 정확, 재번호 매긴 경우 위치 폴백)
 */
function embedArticleIdsInHtml(html: string, orderedArticles: any[]): string {
  if (!html || !orderedArticles.length) return html;

  const $ = cheerioLoad(html);
  const validArticleIds = new Set<string>(orderedArticles.map((a) => a.id).filter(Boolean));

  // URL → article ID 룩업맵 (pathname 기준)
  const urlToId = new Map<string, string>();
  for (const a of orderedArticles) {
    if (a.url && a.id) {
      try { urlToId.set(new URL(a.url).pathname, a.id); } catch { urlToId.set(a.url, a.id); }
    }
  }

  // 제목 정규화 → article ID 룩업맵 (AI가 ref-table 번호를 재매기는 경우 대응)
  const titleToId = new Map<string, string>();
  for (const a of orderedArticles) {
    if (a.title && a.id) {
      titleToId.set((a.title as string).replace(/\s+/g, '').toLowerCase(), a.id);
    }
  }

  function resolveIdByUrl(href: string): string | null {
    if (!href) return null;
    try {
      const targetUrl = new URL(href);
      const targetPath = targetUrl.pathname;
      if (targetPath === '/' && href.length < 15) return null;
      
      for (const [url, id] of urlToId) {
        if (url === href) return id;
        try {
          const aUrl = new URL(url);
          if (targetPath !== '/' && aUrl.pathname === targetPath) return id;
          if (aUrl.hostname === targetUrl.hostname && aUrl.pathname === targetPath && aUrl.search === targetUrl.search) return id;
        } catch { /* ignore invalid url */ }
      }
    } catch {
      if (urlToId.has(href)) return urlToId.get(href)!;
    }
    return null;
  }

  function resolveIdByHeadline(text: string): string | null {
    if (!text) return null;
    // Remove all whitespace and punctuation for robust matching
    const normalize = (s: string) => s.replace(/[\s\p{P}]/gu, '').toLowerCase();
    
    const normalized = normalize(text);
    if (!normalized) return null;

    if (titleToId.has(normalized)) return titleToId.get(normalized)!;
    if (normalized.length < 2) return null;

    let bestMatchId: string | null = null;
    let maxOverlap = 0;
    
    for (const [storedTitle, id] of titleToId) {
      const t = normalize(storedTitle);
      if (!t) continue;
      
      if (t.includes(normalized) || normalized.includes(t)) {
        const ratio = Math.min(t.length, normalized.length) / Math.max(t.length, normalized.length);
        if (ratio > maxOverlap) {
          maxOverlap = ratio;
          bestMatchId = id;
        }
      } else {
        const getBigrams = (str: string) => {
          const bigrams = new Set<string>();
          for (let i = 0; i < str.length - 1; i++) bigrams.add(str.slice(i, i + 2));
          return bigrams;
        };
        
        const bigrams1 = getBigrams(normalized);
        const bigrams2 = getBigrams(t);
        if (bigrams1.size === 0 || bigrams2.size === 0) continue;
        
        let intersection = 0;
        for (const b of bigrams1) {
          if (bigrams2.has(b)) intersection++;
        }
        
        const diceCoefficient = (2.0 * intersection) / (bigrams1.size + bigrams2.size);
        if (diceCoefficient > maxOverlap) {
          maxOverlap = diceCoefficient;
          bestMatchId = id;
        }
      }
    }
    
    // Increase threshold to 0.85 to strictly avoid wrong matches
    if (bestMatchId && maxOverlap >= 0.85) return bestMatchId;
    return null;
  }

  // 1. article-block 원문 보기 버튼에 data-article-id 삽입
  $('details.article-block, div.article-block').each(function () {
    const blockId = ($(this).attr('data-article-id') || '').trim() || null;
    const btn = $(this).find('.article-source-btn');
    const titleAnchor = $(this).find('.article-title a').first();
    const hrefFromTitle = (titleAnchor.attr('href') || '').trim();
    const hrefFromBtn = btn.length ? (btn.attr('href') || '').trim() : '';
    const href = hrefFromBtn || hrefFromTitle;
    const titleText = $(this).find('.article-title').text().trim();

    const urlResolvedId = resolveIdByUrl(href);
    const textResolvedId = resolveIdByHeadline(titleText);

    const isBlockIdUuid = Boolean(blockId && blockId.length > 5 && isNaN(Number(blockId)) && validArticleIds.has(blockId));
    // Final fallback: numeric index (1-based) from blockId — AI sometimes uses "1", "2", etc.
    const numericFallback = (!isBlockIdUuid && blockId) ? (parseInt(blockId, 10) - 1) : -1;
    const indexFallback = (numericFallback >= 0 && numericFallback < orderedArticles.length) ? orderedArticles[numericFallback].id : null;
    const articleId = (isBlockIdUuid ? blockId : null) || textResolvedId || urlResolvedId || indexFallback || null;

    if (articleId) {
      $(this).attr('data-article-id', articleId);
      if (btn.length) btn.attr('data-article-id', articleId);
    }
  });

  // 2. ref-table 헤드라인 셀에 data-article-id 삽입
  // 우선순위: (1) 제목 텍스트 매칭 → (2) AI가 심은 ID
  $('.ref-table tr').each(function () {
    const cells = $(this).find('td');
    if (!cells.length) return;
    const headlineCell = cells.eq(2);
    if (!headlineCell.length) return;

    const rawNum = (cells.eq(0).text() || '').replace(/[^\d]/g, '').trim();
    const articleIdx = rawNum ? parseInt(rawNum, 10) - 1 : -1;

    const headlineText = (headlineCell.text() || '').trim();
    const textMatchedId = resolveIdByHeadline(headlineText);

    let rowArticleId = ($(this).attr('data-article-id') || '').trim() || null;
    if (rowArticleId && !orderedArticles.some(a => a.id === rowArticleId)) rowArticleId = null;

    let isRowIdUuid = rowArticleId && rowArticleId.length > 5 && isNaN(Number(rowArticleId));
    // Remove the fragile array index fallback that causes wrong article mapping when AI reorders list
    const articleId = (isRowIdUuid ? rowArticleId : null) || textMatchedId || null;
    
    // 이메일이나 외부 공유 시 가장 무난하게 보이고 박스가 생기지 않는 스타일을 적용
    const linkStyles = 'cursor:pointer; text-decoration:underline; color:#1e3a5f; background:transparent; border:none; padding:0; outline:none; display:inline; font-weight:500;';

    const existingBtn = headlineCell.find('[data-article-ref], button, span.ref-headline-btn, a.ref-headline-btn');
    if (existingBtn.length) {
      const inner = existingBtn.html() || '';
      const newEl = $(`<a href="#" class="ref-headline-btn" style="${linkStyles}" data-article-ref="${articleIdx}" data-article-id="${articleId || ''}">${inner}</a>`);
      existingBtn.replaceWith(newEl);
    } else {
      // 헤드라인 텍스트를 감싸고 data-article-id 삽입 (button 대신 a 태그 사용)
      const inner = headlineCell.html() || '';
      headlineCell.html(`<a href="#" class="ref-headline-btn" style="${linkStyles}" data-article-ref="${articleIdx}" data-article-id="${articleId || ''}">${inner}</a>`);
    }
  });

  return $.html();
}

// digest에 실제로 사용된 기사 순서(정렬 후)를 반환 — 각주 번호가 이 순서와 일치해야 함
function prioritizeArticlesForDigest(articles: any[]): any[] {
  const sorted = [...articles].sort((a, b) => {
    const scoreGap = Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0);
    if (scoreGap !== 0) return scoreGap;
    const analyzedGap = Number(Boolean(b.summary?.length || b.category || b.tags?.length)) - Number(Boolean(a.summary?.length || a.category || a.tags?.length));
    if (analyzedGap !== 0) return analyzedGap;
    const timeA = a.publishedAt?.toDate ? a.publishedAt.toDate().getTime() : new Date(a.publishedAt || 0).getTime();
    const timeB = b.publishedAt?.toDate ? b.publishedAt.toDate().getTime() : new Date(b.publishedAt || 0).getTime();
    return timeB - timeA;
  });

  // digest 시점 중복 제거: 제목 토큰 유사도 0.75 초과 기사 필터링
  const deduped: any[] = [];
  for (const article of sorted) {
    const isDup = deduped.some(
      (kept) => calculateTokenSimilarity(article.title || '', kept.title || '') > 0.75,
    );
    if (!isDup) deduped.push(article);
  }
  return deduped.slice(0, 100);
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
      `ID: ${article.id}`,
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
      `ID: ${article.id}`,
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

    const systemPrompt = `${basePrompt}

[필수 지시사항]
보고서의 모든 내용(제목, 요약, 트렌드, 태그 포함)을 반드시 자연스러운 한국어로 작성하세요.
영어 문장은 절대 출력하지 마세요. 고유명사(기업명, 펀드명)는 한국어 표기 후 필요 시 영문 병기.`;

    const prompt = buildSafePrompt(
      `${systemPrompt}\n\nCompany: ${options.companyId}\nOutput title: ${options.outputConfig.title || 'AI News Output'}\nArticle digest:`,
      digest
    );

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
    status: 'completed',
    articleIds: limitedArticles.map(article => article.id),
    articleCount: limitedArticles.length,
    rawOutput: normalized.text,
    structuredOutput: normalized.structured,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
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
  const { digest: articleDigest, orderedArticles } = buildCustomReportArticleDigest(articles);
  const reportAiConfig = resolveCustomReportAiConfig(options.aiConfig);
  const companyDisplayName = await resolveCompanyDisplayName(options.companyId);
  const keywordSummary = options.keywords.length > 0 ? options.keywords.join(', ') : 'deal flow, investment, portfolio, private equity';
  const reportTitle = options.reportTitle || `${companyDisplayName} Market Intelligence Report`;
  const safeReportTitle = escapeHtml(reportTitle);
  const volNumber = options.volNumber || 1;

  // 서버에서 완벽한 HTML 뼈대(Skeleton)를 사전 생성하여 AI에게 전달 (Fill-in-the-blank 방식)
  const articleBlocksSkeleton = orderedArticles.map((a: any, index: number) => `
    <div class="article-block" data-article-id="${a.id}">
      <div class="article-sector">[AI_FILL: 섹터/카테고리 태그 (예: M&A, IPO 등)]</div>
      <div class="article-title"><a href="${escapeHtml(a.url || '#')}">${escapeHtml(fixEncodingIssues(cleanHtmlContent(a.title || '')))}</a></div>
      <div class="article-analysis">
        [AI_FILL: 기사 ${index + 1}에 대한 심층 분석 내용 작성 (단락별로 <p> 태그 사용)]
      </div>
    </div>
  `).join('\n');

  const refTableSkeleton = orderedArticles.map((a: any, index: number) => {
    const dateStr = a.publishedAt?.toDate ? a.publishedAt.toDate().toLocaleDateString('ko-KR') : (a.publishedAt || '');
    return `      <tr data-article-id="${a.id}"><td>${index + 1}</td><td>${dateStr}</td><td>${escapeHtml(fixEncodingIssues(cleanHtmlContent(a.title || '')))}</td><td>${escapeHtml(fixEncodingIssues(cleanHtmlContent(a.source || '')))}</td></tr>`;
  }).join('\n');

  const systemPrompt = `You are a senior private equity analyst.
Output a complete HTML report in Korean for investment professionals.

Universal Requirements (always apply):
1. Output a COMPLETE HTML document: <!DOCTYPE html> through </html>, with <head> containing <meta charset="UTF-8"> and embedded <style>.
2. LIGHT MODE ONLY — white background (#ffffff), dark body text (#111827 or #1f2937). NEVER use white or light-colored text. Do NOT include dark mode CSS or @media (prefers-color-scheme: dark).
3. All headings, labels, and body text must be in Korean. Exception: proper nouns, company names, and financial abbreviations (M&A, PE, IPO, GP, LP, etc.).
4. Do NOT include footnote reference numbers like [1], [2], [3] anywhere in the report body.
5. Section numbers must be strictly sequential.

[CRITICAL INSTRUCTION: FILL IN THE BLANKS]
You MUST use the exact HTML skeleton provided in the user prompt below.
Your ONLY job is to replace the "[AI_FILL: ...]" placeholders with your actual expert analysis.
DO NOT alter any existing HTML tags, class names, href attributes, or data-article-id attributes.
DO NOT remove or modify the reference table at the bottom.

[ANALYSIS INSTRUCTIONS — HIGHEST PRIORITY]
Follow the instructions below EXACTLY. They define the structure, format, tone, and content scope.
${options.analysisPrompt || 'Focus on market structure, deal meaning, buyer and seller implications, and PE relevance.'}${options.structureGuide ? `\n\n${options.structureGuide}` : ''}`;

  const userPrompt = `Report title: ${reportTitle}
Company: ${companyDisplayName}
Priority keywords: ${keywordSummary}
Selected article count: ${articles.length}
Use at most the strongest 100 articles already curated below.

Article digest:
${articleDigest}

Below is the HTML skeleton you MUST use and fill in.
Replace all "[AI_FILL: ...]" placeholders with your analysis based on the instructions.
Do not change the structure or IDs.

<HTML_SKELETON>
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>${safeReportTitle}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111827; background: #ffffff; line-height: 1.6; padding: 20px; max-width: 1000px; margin: 0 auto; }
    h1 { font-size: 24px; font-weight: bold; margin-bottom: 20px; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; }
    .article-block { margin-bottom: 40px; padding-bottom: 20px; border-bottom: 1px solid #f3f4f6; }
    .article-sector { display: inline-block; padding: 4px 10px; background: #f3f4f6; border-radius: 4px; font-size: 12px; font-weight: bold; color: #4b5563; margin-bottom: 10px; }
    .article-title { font-size: 18px; font-weight: bold; margin-bottom: 15px; }
    .article-title a { color: #2563eb; text-decoration: none; }
    .article-title a:hover { text-decoration: underline; }
    .article-analysis { font-size: 15px; color: #374151; }
    .article-analysis p { margin-bottom: 12px; }
    .ref-table { width: 100%; border-collapse: collapse; margin-top: 30px; font-size: 13px; }
    .ref-table th, .ref-table td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
    .ref-table th { background: #f9fafb; font-weight: bold; }
    .ref-table td a { color: #2563eb; text-decoration: none; }
  </style>
</head>
<body>
  <h1>${safeReportTitle}</h1>
  
  <div class="report-content">
${articleBlocksSkeleton}
  </div>

  <table class="ref-table">
    <thead><tr><th>번호</th><th>날짜</th><th>헤드라인</th><th>매체</th></tr></thead>
    <tbody>
${refTableSkeleton}
    </tbody>
  </table>
</body>
</html>
</HTML_SKELETON>
`;

  const finalPrompt = buildSafePrompt(systemPrompt, userPrompt);

  const response = await callAiProvider(
    finalPrompt,
    reportAiConfig,
    resolveAiCallOptions(reportAiConfig.provider, 'custom-report', { maxTokens: 32000, temperature: 0.4 }),
    options.companyId
  );
  await trackAiCost('custom-output', response.usage, response.model, response.provider, options.companyId);

  // AI 생성 HTML 검증 (ID가 이미 템플릿으로 주어졌으므로 embedArticleIdsInHtml의 의존도가 낮아짐)
  const rawHtmlContent = ensureHtmlDocument(response.content, reportTitle);
  const htmlContent = embedArticleIdsInHtml(rawHtmlContent, orderedArticles);

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

export async function generateEumDailyReport(options: CustomReportOptions) {
  const db = admin.firestore();

  const articleDocs = await Promise.all(
    options.articleIds.map((id) => db.collection('articles').doc(id).get())
  );
  const articles = articleDocs
    .filter((doc) => doc.exists)
    .map((doc) => ({ id: doc.id, ...(doc.data() as any) }));

  if (articles.length === 0) throw new Error('No selected articles were found.');

  const { digest: articleDigest, orderedArticles } = buildCustomReportArticleDigest(articles);
  const reportAiConfig = resolveCustomReportAiConfig(options.aiConfig);
  const reportTitle = options.reportTitle || '이음M&A뉴스';
  const safeReportTitle = escapeHtml(reportTitle);
  const volNumber = options.volNumber || 1;

  const today = new Date();
  const dateStr = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일`;

  const articleBlocksSkeleton = orderedArticles.map((a: any, index: number) => `
<!-- [기사 ${index + 1}] ${fixEncodingIssues(cleanHtmlContent(a.title || ''))} -->
<div class="article-block" data-article-id="${a.id}">
  <span class="article-title"><a href="${a.url || '#'}">(${index + 1}) ${fixEncodingIssues(cleanHtmlContent(a.title || ''))}</a></span>
  <span class="article-sector">[AI_FILL: 업종/섹터 (예: 반도체, 바이오, IT 등)]</span>
  
  <div class="article-meta-block">
    <span class="label">분류:</span> <span class="meta-category">[AI_FILL: M&A / PE / 기타 중 택1]</span><br>
    <span class="label">당사자:</span> [AI_FILL: 인수자 / 피인수자 / 관련 기업]<br>
    <span class="label">딜 규모:</span> [AI_FILL: 금액 (기사에 언급된 경우만, 없으면 빈칸)]<br>
    <span class="label">딜 구조:</span> [AI_FILL: 인수 / 합병 / 지분투자 / 매각 등 (기사에 언급된 경우만, 없으면 빈칸)]
  </div>
  
  <ul style="font-size:10pt; color:#333; margin-top:10px; line-height:1.8; padding-left:20px;">
    <li>[AI_FILL: 핵심 사실 1 (bullet 형태, 한 문장으로 요약)]</li>
    <li>[AI_FILL: 핵심 사실 2 (bullet 형태, 한 문장으로 요약)]</li>
    <li>[AI_FILL: 핵심 사실 3 (bullet 형태, 한 문장으로 요약)]</li>
  </ul>
</div>
`).join('\n\n');

  const refTableSkeleton = orderedArticles.map((a: any, index: number) => {
    const pubDate = a.publishedAt?.toDate ? a.publishedAt.toDate().toLocaleDateString('ko-KR') : (a.publishedAt || '');
    return `    <tr data-article-id="${a.id}">
      <td>${index + 1}</td><td>[AI_FILL: M&A/PE/기타]</td><td>${fixEncodingIssues(cleanHtmlContent(a.title || ''))}</td><td>${fixEncodingIssues(cleanHtmlContent(a.source || ''))}</td><td>${pubDate}</td><td></td>
    </tr>`;
  }).join('\n');

  const systemPrompt = `당신은 PE(Private Equity) 하우스의 시니어 애널리스트입니다.

[작성 원칙]
1. 기사 원문의 내용만 충실히 전달합니다. 추측·전망·제언을 추가하지 않습니다.
2. 딜 규모가 기사에 미언급이면 해당 줄 자체를 생략합니다 (빈 칸으로 두지 말 것).
3. 출처 번호([1][2] 등)는 제목·본문 어디에도 표시하지 않습니다.
4. 분류 우선순위: M&A > PE 동향 > 기타 시장 동향 (PE가 수행한 M&A → M&A로 분류).

[출력 방식]
아래 <HTML_SKELETON>의 [AI_FILL: ...] 부분만 채우세요.
HTML 태그·클래스명·data-article-id 속성은 절대 변경하지 마세요.
모든 기사 블록을 빠짐없이 유지하세요 (임의 병합·삭제 금지).

<HTML_SKELETON>
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>${safeReportTitle}</title>
  <style>
    body { font-family: 'Noto Sans KR', 'Malgun Gothic', sans-serif; color: #333; line-height: 1.7; max-width: 800px; margin: 0 auto; padding: 20px; background: #fff; }
    .report-header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1a2a4a; padding-bottom: 12px; margin-bottom: 30px; }
    .report-title { font-size: 28px; font-weight: 800; color: #1a2a4a; }
    .report-subtitle { font-size: 13px; color: #666; margin-top: 2px; }
    .report-date-block { text-align: right; font-size: 13px; color: #2b3a5c; background: #fff; padding: 10px 16px; border-radius: 2px; }
    .report-date-block .date { font-size: 15px; font-weight: 700; color: #5bb5e0; }
    .part-title { border-left: 4px solid #c75a3b; padding: 8px 14px; font-size: 12pt; font-weight: 700; color: #1a2a4a; background: #f5f7fa; margin: 36px 0 20px 0; }
    .article-block { margin-bottom: 28px; padding-bottom: 20px; border-bottom: 1px solid #e8e8e8; }
    .article-title { font-size: 12pt; font-weight: 700; color: #111; }
    .article-title a { color: #111; text-decoration: none; }
    .article-title a:hover { text-decoration: underline; }
    .article-sector { float: right; background: #e8f0f8; color: #1a6fa8; font-size: 9pt; font-weight: 600; padding: 2px 10px; border-radius: 3px; }
    .article-meta-block { font-size: 9pt; color: #555; background: #F8FAFC; padding: 8px 12px; margin: 8px 0; line-height: 1.8; }
    .article-meta-block .label { font-weight: 700; color: #333; }
    .ref-table { width: 100%; border-collapse: collapse; font-size: 9pt; margin-top: 12px; }
    .ref-table th { background: #1a2a4a; color: #fff; padding: 8px 10px; text-align: left; font-weight: 600; }
    .ref-table td { padding: 7px 10px; border-bottom: 1px solid #e0e0e0; color: #333; }
    .ref-table tr:nth-child(even) td { background: #f9f9f9; }
    .ref-summary { font-size: 9pt; color: #888; margin-top: 8px; text-align: right; }
  </style>
</head>
<body>
  <!-- ■ 헤더 -->
  <div class="report-header">
    <div>
      <div class="report-title">이음M&A뉴스</div>
      <div class="report-subtitle">EUM Daily Report</div>
    </div>
    <div class="report-date-block">
      <div class="date">${dateStr}</div>
      <div>이음프라이빗에쿼티</div>
      <div>Vol. ${volNumber}</div>
    </div>
  </div>

  <div id="ai-raw-blocks">
    ${articleBlocksSkeleton}
  </div>

  <!-- ■ 참고 기사 목록 -->
  <div class="part-title">참고 기사 목록</div>
  <table class="ref-table">
    <tr>
      <th>#</th><th>카테고리</th><th>헤드라인</th><th>출처</th><th>날짜</th><th>비고</th>
    </tr>
${refTableSkeleton}
  </table>
  <div class="ref-summary">총 입력 기사: ${orderedArticles.length}건</div>
</body>
</html>
</HTML_SKELETON>
`;

  const userPrompt = `기사 목록:
${articleDigest}

위 <HTML_SKELETON>의 [AI_FILL: ...] 영역을 채워서 완성된 HTML을 반환하세요.`;

  const response = await callAiProvider(
    `${systemPrompt}\n\n${userPrompt}`,
    reportAiConfig,
    resolveAiCallOptions(reportAiConfig.provider, 'custom-report', { maxTokens: 32000, temperature: 0.4 }),
    options.companyId
  );
  await trackAiCost('eum-daily-output', response.usage, response.model, response.provider, options.companyId);

  // --- Cheerio Post-processing (Part 1, 2, 3 분류 재배치) ---
  const rawHtml = ensureHtmlDocument(response.content, reportTitle);
  const $ = cheerioLoad(rawHtml);
  const categoryById = new Map<string, string>(
    orderedArticles.map((a: any) => [a.id, `${a.category || ''}`.toUpperCase()])
  );

  // 파트 컨테이너 생성
  const part1 = $('<div class="report-part" id="part-1-ma"><div class="part-title">PART 1. M&A</div><div class="part-body"></div></div>');
  const part2 = $('<div class="report-part" id="part-2-pe"><div class="part-title">PART 2. PE 동향</div><div class="part-body"></div></div>');
  const part3 = $('<div class="report-part" id="part-3-others"><div class="part-title">PART 3. 기타 시장 동향</div><div class="part-body"></div></div>');

  // AI가 작성한 기사 블록들을 카테고리에 맞게 이동
  $('#ai-raw-blocks .article-block').each(function () {
    const block = $(this);
    const categoryEl = block.find('.meta-category').first();
    const rawCategoryText = categoryEl.text().toUpperCase();
    const blockId = (block.attr('data-article-id') || '').trim();
    const fallbackCategory = (blockId ? (categoryById.get(blockId) || '') : '');
    const categoryText = rawCategoryText.includes('[AI_FILL') || rawCategoryText.trim().length === 0
      ? fallbackCategory
      : rawCategoryText;

    const metaBlock = block.find('.article-meta-block').first();
    if (metaBlock.length && categoryEl.length) {
      const label = metaBlock.find('.label').filter((_, el) => $(el).text().trim().startsWith('분류')).first();
      if (label.length) label.remove();
      categoryEl.remove();
      const br = metaBlock.find('br').first();
      if (br.length) br.remove();
      metaBlock.contents().each(function () {
        if (this.type === 'text' && !($(this).text() || '').trim()) {
          $(this).remove();
        }
      });
    }

    if (categoryText.includes('M&A') || categoryText.includes('인수합병')) {
      part1.find('.part-body').append(this);
    } else if (categoryText.includes('PE') || categoryText.includes('VC') || categoryText.includes('사모펀드') || categoryText.includes('펀드')) {
      part2.find('.part-body').append(this);
    } else {
      part3.find('.part-body').append(this);
    }
  });

  // 기존 ai-raw-blocks 자리에 파트들 삽입
  const partHtml = [
    part1.find('.article-block').length > 0 ? (part1.prop('outerHTML') || '') : '',
    part2.find('.article-block').length > 0 ? (part2.prop('outerHTML') || '') : '',
    part3.find('.article-block').length > 0 ? (part3.prop('outerHTML') || '') : '',
  ].join('');
  $('#ai-raw-blocks').replaceWith(partHtml);

  const finalHtmlContent = embedArticleIdsInHtml($.html(), orderedArticles);

  const outputRef = options.outputId ? db.collection('outputs').doc(options.outputId) : db.collection('outputs').doc();
  await outputRef.set({
    id: outputRef.id,
    companyId: options.companyId,
    type: 'eum_daily_report',
    title: reportTitle,
    volNumber,
    keywords: options.keywords,
    analysisPrompt: options.savedPrompt !== undefined ? options.savedPrompt : options.analysisPrompt,
    articleIds: options.articleIds,
    orderedArticleIds: orderedArticles.map((a: any) => a.id),
    articleCount: articles.length,
    digestArticleCount: orderedArticles.length,
    htmlContent: finalHtmlContent,
    rawOutput: finalHtmlContent,
    structuredOutput: null,
    requestedBy: options.requestedBy,
    status: 'completed',
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...(options.outputMetadata || {}),
    ...(!options.outputId ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
  }, { merge: true });

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
