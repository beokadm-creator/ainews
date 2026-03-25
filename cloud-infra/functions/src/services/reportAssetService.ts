import * as admin from 'firebase-admin';
import { load } from 'cheerio';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import * as fs from 'fs/promises';
import * as path from 'path';
import { cleanHtmlContent, fixEncodingIssues } from '../utils/encodingUtils';

interface ReportBranding {
  publisherName: string;
  logoDataUrl: string | null;
}

interface OutputHtmlAsset {
  output: any;
  articles: any[];
  html: string;
  htmlFilename: string;
}

function stripMarkdownCodeFence(raw: string) {
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

function extractHtmlPayload(raw: string) {
  const cleaned = stripMarkdownCodeFence(raw || '').trim();
  const doctypeIdx = cleaned.search(/<!doctype\s+html/i);
  if (doctypeIdx >= 0) return cleaned.slice(doctypeIdx).trim();
  const htmlIdx = cleaned.search(/<html[\s>]/i);
  if (htmlIdx >= 0) return cleaned.slice(htmlIdx).trim();
  return cleaned;
}

function sanitizeText(value: string) {
  return fixEncodingIssues(cleanHtmlContent(value || ''))
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .trim();
}

function sanitizeFileName(value: string) {
  return (value || 'report')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'report';
}

function escapeHtml(value: string) {
  return `${value || ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeArticleContent(value: string) {
  const noiseLinePatterns = [
    /^다른기사\s*보기$/i,
    /^지금\s*인기\s*있는\s*기사$/i,
    /^Pin'?s\s*Pick$/i,
    /^저작권자\s*[©\s]/i,
    /^무단전재\s*및\s*재배포\s*금지/i,
    /^기사제보/i,
    /^바로가기$/i,
    /^\d+\s*$/,
  ];
  const inlineCutoffPatterns = [
    /저작권자\s*[©\s]/i,
    /무단전재\s*및\s*재배포\s*금지/i,
    /지금\s*인기\s*있는\s*기사/i,
    /Pin'?s\s*Pick/i,
    /다른기사\s*보기/i,
  ];
  const normalizeLine = (line: string) => line.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const normalized = `${value || ''}`
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return '';

  const cutoffIndex = inlineCutoffPatterns
    .map((pattern) => normalized.search(pattern))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  const sliced = typeof cutoffIndex === 'number' ? normalized.slice(0, cutoffIndex) : normalized;

  return sliced
    .split(/\n{1,2}/)
    .map(normalizeLine)
    .filter((line) => line && !noiseLinePatterns.some((pattern) => pattern.test(line)))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLongParagraph(paragraph: string) {
  const compact = paragraph.replace(/\s+/g, ' ').trim();
  if (compact.length <= 220) return [compact];

  const sentences = compact.split(/(?<=[.!?]|[다요죠]\.|니다\.|입니다\.|했다\.|했다\!|했다\?)\s+/);
  if (sentences.length <= 1) return [compact];

  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > 220 && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function formatArticleContentParagraphs(value: string) {
  const normalized = normalizeArticleContent(value);
  if (!normalized) return [];

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap(splitLongParagraph);
}

function buildArticleModalPayload(article: any, index: number) {
  return {
    index: index + 1,
    id: article.id || '',
    title: sanitizeText(article.title || '제목 없음'),
    source: sanitizeText(article.source || ''),
    publishedAt: (() => {
      try {
        if (article.publishedAt?.toDate) return article.publishedAt.toDate().toLocaleString('ko-KR');
        if (article.publishedAt?.seconds) return new Date(article.publishedAt.seconds * 1000).toLocaleString('ko-KR');
        if (article.publishedAt) return new Date(article.publishedAt).toLocaleString('ko-KR');
      } catch {
        return '';
      }
      return '';
    })(),
    summary: Array.isArray(article.summary) ? article.summary.map((line: string) => sanitizeText(line)).filter(Boolean) : [],
    contentParagraphs: formatArticleContentParagraphs(article.content || ''),
    url: article.url || '',
  };
}

function injectReferenceLinks(bodyHtml: string, articleCount: number) {
  if (!bodyHtml || articleCount <= 0) return bodyHtml;

  return bodyHtml.replace(/\[(\d{1,3})\]/g, (match, rawIndex) => {
    const refIndex = Number(rawIndex);
    if (!Number.isInteger(refIndex) || refIndex < 1 || refIndex > articleCount) return match;
    return `<button type="button" class="article-ref-trigger" data-article-ref="${refIndex - 1}" aria-label="참고 기사 ${refIndex}번 보기">[${refIndex}]</button>`;
  });
}

function escapeJsonForHtml(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function sanitizeGeneratedReportBody(bodyHtml: string) {
  if (!bodyHtml) return '';

  const $ = load(bodyHtml);

  $('p, div, span, li').each((_, element) => {
    const text = sanitizeText($(element).text());
    if (!text) return;

    if (
      /분석기관\s*:/.test(text) ||
      /이 문서는 .* 발행한 분석 리포트/.test(text) ||
      /선택된 매체와 키워드를 기준/.test(text) ||
      /^선택 매체$/.test(text) ||
      /^실제 반영 매체$/.test(text) ||
      /^키워드$/.test(text) ||
      /기사\s*\d+건/.test(text)
    ) {
      $(element).remove();
    }
  });

  $('section, article, div').each((_, element) => {
    const heading = $(element).find('h1,h2,h3,h4').first();
    const headingText = sanitizeText(heading.text()).toLowerCase();
    if (!headingText) return;

    if (
      /투자 기회|기회 요인|제언|권고|추천|next steps|opportunities|recommendations|outlook/.test(headingText)
    ) {
      $(element).remove();
    }
  });

  return $('body').length > 0 ? ($('body').html() || '') : $.root().html() || '';
}

export function resolveOutputDate(output: any): string {
  try {
    if (output.createdAt?.toDate) return output.createdAt.toDate().toLocaleDateString('ko-KR');
    if (output.createdAt?.seconds) return new Date(output.createdAt.seconds * 1000).toLocaleDateString('ko-KR');
    if (output.createdAt) return new Date(output.createdAt).toLocaleDateString('ko-KR');
  } catch {
    // ignore invalid date shapes
  }
  return new Date().toLocaleDateString('ko-KR');
}

async function loadCompanyBranding(companyId?: string | null): Promise<ReportBranding> {
  if (!companyId) {
    return {
      publisherName: '이음프라이빗에쿼티',
      logoDataUrl: null,
    };
  }

  try {
    const settingsDoc = await admin.firestore().collection('companySettings').doc(companyId).get();
    const settings = settingsDoc.data() as any;
    if (settings?.branding?.publisherName || settings?.companyName) {
      return {
        publisherName: settings?.branding?.publisherName || settings?.companyName || '이음프라이빗에쿼티',
        logoDataUrl: settings?.branding?.logoDataUrl || null,
      };
    }

    const companyDoc = await admin.firestore().collection('companies').doc(companyId).get();
    const companyData = companyDoc.data() as any;
    return {
      publisherName: companyData?.name || companyData?.displayName || '이음프라이빗에쿼티',
      logoDataUrl: settings?.branding?.logoDataUrl || null,
    };
  } catch {
    return {
      publisherName: '이음프라이빗에쿼티',
      logoDataUrl: null,
    };
  }
}

function buildFallbackReportHtml(output: any, articles: any[]) {
  const structured = output.structuredOutput || {};
  const highlights: any[] = structured.highlights || [];
  const trends: any[] = structured.trends || [];
  const themes: any[] = structured.themes || [];
  const summary: string = structured.summary || output.rawOutput || '';
  const dateStr = resolveOutputDate(output);

  const renderSection = (title: string, body: string) => `
    <section class="report-section">
      <h2>${title}</h2>
      ${body}
    </section>
  `;

  const articleHtml = articles.map((article: any, index: number) => `
    <article class="article-card">
      <div class="article-index">[${index + 1}]</div>
      <div class="article-main">
        <h3>${article.title || ''}</h3>
        <div class="article-meta">${article.source || ''}</div>
        <ul>
          ${(article.summary || []).map((item: string) => `<li>${item}</li>`).join('')}
        </ul>
      </div>
    </article>
  `).join('');

  return `<!DOCTYPE html>
  <html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>${output.title || '이음프라이빗에쿼티 리포트'}</title>
    <style>
      body { margin: 0; background: #f4f6f8; color: #1f2937; font-family: "Noto Sans KR Variable", "Malgun Gothic", sans-serif; }
      .report-shell { max-width: 920px; margin: 0 auto; background: #fff; }
      .hero { padding: 40px 42px 28px; background: linear-gradient(135deg, #16324f 0%, #244f76 100%); color: #fff; }
      .hero h1 { margin: 14px 0 10px; font-size: 30px; line-height: 1.3; color: #f2d27b; }
      .hero p { margin: 0; opacity: 0.9; font-size: 14px; }
      .eyebrow { display: inline-block; padding: 6px 10px; border-radius: 999px; background: rgba(255,255,255,0.12); font-size: 12px; letter-spacing: 0.04em; }
      .report-section { padding: 28px 42px; border-bottom: 1px solid #e5e7eb; }
      .report-section h2 { margin: 0 0 14px; color: #16324f; font-size: 20px; }
      .highlight-box { border: 1px solid #dbe4ef; border-left: 4px solid #16324f; border-radius: 14px; padding: 16px; margin-bottom: 12px; background: #f8fafc; }
      .highlight-title { font-weight: 700; color: #16324f; }
      .body-copy { margin-top: 8px; white-space: pre-wrap; line-height: 1.75; font-size: 14px; color: #334155; }
      .article-card { display: flex; gap: 12px; padding: 14px 0; border-top: 1px dashed #d1d5db; }
      .article-card:first-child { border-top: none; padding-top: 0; }
      .article-index { flex: 0 0 auto; font-weight: 700; color: #16324f; }
      .article-main h3 { margin: 0 0 8px; font-size: 16px; color: #111827; }
      .article-meta { font-size: 12px; color: #64748b; }
      .article-main ul { margin: 10px 0 0 18px; padding: 0; color: #475569; }
      .footer { padding: 22px 42px 32px; background: #f8fafc; color: #94a3b8; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="report-shell">
      <header class="hero">
        <span class="eyebrow">EUM PRIVATE EQUITY REPORT</span>
        <h1>${output.title || '이음프라이빗에쿼티 리포트'}</h1>
        <p>${dateStr} · 기사 ${output.articleCount || articles.length}건 기준</p>
      </header>
      ${summary ? renderSection('핵심 요약', `<div class="body-copy">${summary}</div>`) : ''}
      ${highlights.length > 0 ? renderSection('주요 하이라이트', highlights.map((item: any) => `
        <div class="highlight-box">
          <div class="highlight-title">${item.title || ''}</div>
          <div class="body-copy">${item.description || ''}</div>
        </div>
      `).join('')) : ''}
      ${trends.length > 0 ? renderSection('시장 동향', trends.map((item: any) => `
        <div class="highlight-box">
          <div class="highlight-title">${item.topic || ''}</div>
          <div class="body-copy">${item.description || ''}</div>
        </div>
      `).join('')) : ''}
      ${themes.length > 0 ? renderSection('핵심 테마', themes.map((item: any) => `
        <div class="highlight-box">
          <div class="highlight-title">${item.name || ''}</div>
          <div class="body-copy">${item.description || ''}</div>
        </div>
      `).join('')) : ''}
      ${renderSection('참고 기사', articleHtml || '<div class="body-copy">참고 기사가 없습니다.</div>')}
      <footer class="footer">이 문서는 이음프라이빗에쿼티가 발행한 AI 리포트입니다.</footer>
    </div>
  </body>
  </html>`;
}

export async function loadOutputArticles(output: any) {
  const db = admin.firestore();

  if (Array.isArray(output.articleIds) && output.articleIds.length > 0) {
    const articleDocs = await Promise.all(
      output.articleIds.map((articleId: string) => db.collection('articles').doc(articleId).get()),
    );
    return articleDocs
      .filter((doc) => doc.exists)
      .map((doc) => ({ id: doc.id, ...(doc.data() as any) }));
  }

  const articlesSnapshot = await db.collection('articles')
    .where('publishedInOutputId', '==', output.id)
    .get();

  return articlesSnapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as any) }));
}

async function getFontCss() {
  const cssPath = path.resolve(
    __dirname,
    '../../node_modules/@fontsource-variable/noto-sans-kr/index.css',
  );
  const fontDir = path.resolve(
    __dirname,
    '../../node_modules/@fontsource-variable/noto-sans-kr/files',
  ).replace(/\\/g, '/');

  const css = await fs.readFile(cssPath, 'utf8');
  return css.replace(/url\(\.\/files\/([^)]+)\)/g, `url("file:///${fontDir}/$1")`);
}

function buildBrandedShell({
  output,
  bodyHtml,
  headStyles,
  branding,
}: {
  output: any;
  bodyHtml: string;
  headStyles: string;
  branding: ReportBranding;
}) {
  const dateLabel = resolveOutputDate(output);
  const logoHtml = branding.logoDataUrl
    ? `<img src="${branding.logoDataUrl}" alt="${branding.publisherName}" class="brand-logo" />`
    : `<div class="brand-badge">${branding.publisherName.slice(0, 1)}</div>`;
  const selectedSourceNames = Array.isArray(output.selectedSourceNames) ? output.selectedSourceNames : [];
  const matchedSourceNames = Array.isArray(output.matchedSourceNames) ? output.matchedSourceNames : [];
  const keywords = Array.isArray(output.keywords) ? output.keywords : [];
  const sourceCoverage = Array.isArray(output.sourceCoverage) ? output.sourceCoverage : [];
  const serviceLabel = output.serviceMode === 'external' ? 'EXTERNAL DISTRIBUTION' : 'INTERNAL INTELLIGENCE';
  const renderChips = (items: string[], tone: 'gold' | 'slate' = 'slate') => items.length > 0
    ? `<div class="chip-row">${items.map((item) => `<span class="meta-chip meta-chip-${tone}">${escapeHtml(item)}</span>`).join('')}</div>`
    : '';
  const coverageHtml = sourceCoverage.length > 0
    ? `<div class="coverage-grid">${sourceCoverage.map((item: any) => `
        <div class="coverage-card">
          <div class="coverage-name">${escapeHtml(item.sourceName || item.sourceId || '')}</div>
          <div class="coverage-count">${Number(item.articleCount || 0)}건 반영</div>
        </div>
      `).join('')}</div>`
    : '';

  return `<!DOCTYPE html>
  <html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${output.title || '이음프라이빗에쿼티 리포트'}</title>
    <style>
      ${headStyles}
    </style>
    <style>
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(212, 175, 55, 0.14), transparent 28%),
          linear-gradient(180deg, #f3f6fa 0%, #e8edf4 100%);
        color: #111827;
        font-family: "Noto Sans KR Variable", "Malgun Gothic", sans-serif;
      }
      .brand-page {
        max-width: 1080px;
        margin: 28px auto;
        background: #ffffff;
        min-height: calc(100vh - 56px);
        border: 1px solid rgba(22, 50, 79, 0.08);
        border-radius: 28px;
        overflow: hidden;
        box-shadow:
          0 20px 45px rgba(15, 23, 42, 0.08),
          0 6px 18px rgba(15, 23, 42, 0.06);
      }
      .brand-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        padding: 30px 38px 26px;
        border-bottom: 1px solid #d9e2ec;
        background:
          linear-gradient(135deg, rgba(22, 50, 79, 0.98) 0%, rgba(28, 69, 111, 0.97) 52%, rgba(212, 175, 55, 0.92) 160%);
      }
      .brand-id {
        display: flex;
        align-items: center;
        gap: 14px;
        min-width: 0;
      }
      .brand-logo {
        width: 58px;
        height: 58px;
        object-fit: contain;
        border-radius: 16px;
        background: rgba(255,255,255,0.96);
        padding: 6px;
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.14);
      }
      .brand-badge {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 58px;
        height: 58px;
        border-radius: 16px;
        background: rgba(255,255,255,0.16);
        color: #ffffff;
        font-size: 26px;
        font-weight: 700;
        border: 1px solid rgba(255,255,255,0.24);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.18);
      }
      .brand-name {
        font-size: 20px;
        font-weight: 700;
        color: #ffffff;
        letter-spacing: -0.02em;
      }
      .brand-note {
        margin-top: 4px;
        font-size: 12px;
        color: rgba(255,255,255,0.72);
      }
      .hero-kicker {
        display: inline-flex;
        align-items: center;
        margin-top: 18px;
        padding: 7px 12px;
        border-radius: 999px;
        background: rgba(255,255,255,0.12);
        border: 1px solid rgba(255,255,255,0.14);
        color: rgba(255,255,255,0.86);
        font-size: 11px;
        letter-spacing: 0.08em;
      }
      .hero-summary {
        margin-top: 14px;
        max-width: 560px;
        font-size: 14px;
        line-height: 1.75;
        color: rgba(255,255,255,0.8);
      }
      .report-meta {
        text-align: right;
        padding: 12px 14px;
        border-radius: 18px;
        background: rgba(255,255,255,0.1);
        border: 1px solid rgba(255,255,255,0.14);
        backdrop-filter: blur(8px);
      }
      .report-title {
        font-size: 16px;
        font-weight: 700;
        color: #ffffff;
        letter-spacing: -0.01em;
      }
      .report-date {
        margin-top: 4px;
        font-size: 12px;
        color: rgba(255,255,255,0.72);
      }
      .overview-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
        gap: 18px;
        margin-bottom: 22px;
      }
      .overview-card {
        padding: 18px 20px;
        border-radius: 22px;
        background: linear-gradient(180deg, #fbfdff 0%, #f4f8fb 100%);
        border: 1px solid #e3ebf4;
        box-shadow: 0 14px 30px rgba(15, 23, 42, 0.05);
      }
      .overview-title {
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #64748b;
      }
      .overview-value {
        margin-top: 10px;
      }
      .chip-row {
        display: flex;
        flex-wrap: wrap;
      }
      .meta-chip {
        display: inline-flex;
        align-items: center;
        margin: 0 8px 8px 0;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
      }
      .meta-chip-gold {
        background: rgba(212, 175, 55, 0.16);
        color: #8a6110;
        border: 1px solid rgba(212, 175, 55, 0.26);
      }
      .meta-chip-slate {
        background: #eef4f9;
        color: #16324f;
        border: 1px solid #dbe5ef;
      }
      .meta-empty {
        color: #64748b;
        font-size: 13px;
      }
      .coverage-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 10px;
        margin-top: 14px;
      }
      .coverage-card {
        padding: 14px 16px;
        border-radius: 16px;
        background: #ffffff;
        border: 1px solid #e5ebf2;
      }
      .coverage-name {
        font-size: 14px;
        font-weight: 700;
        color: #16324f;
      }
      .coverage-count {
        margin-top: 6px;
        font-size: 13px;
        color: #64748b;
      }
      .report-body {
        padding: 30px 38px 0;
      }
      .report-body > *:first-child {
        margin-top: 0 !important;
      }
      .report-body .container,
      .report-body .report-shell {
        max-width: none;
        margin: 0;
        box-shadow: none;
      }
      .report-body article.report-content,
      .report-body .report-shell {
        background: transparent !important;
      }
      .report-body .hero {
        border-radius: 24px;
        overflow: hidden;
        margin-bottom: 22px;
        box-shadow: 0 18px 32px rgba(22, 50, 79, 0.12);
      }
      .report-body .report-section,
      .report-body section {
        border-radius: 22px;
        background: #ffffff;
        border: 1px solid #e5ebf2;
        box-shadow: 0 10px 22px rgba(15, 23, 42, 0.04);
        margin-bottom: 18px;
      }
      .report-body h1,
      .report-body h2,
      .report-body h3 {
        letter-spacing: -0.02em;
      }
      .report-body p,
      .report-body li {
        line-height: 1.78;
        color: #334155;
      }
      .report-body ul,
      .report-body ol {
        padding-left: 1.25rem;
      }
      .report-body table {
        width: 100%;
        border-collapse: collapse;
        overflow: hidden;
        border-radius: 16px;
        font-size: 14px;
      }
      .report-body th,
      .report-body td {
        border: 1px solid #e5e7eb;
        padding: 10px 12px;
        vertical-align: top;
      }
      .report-body th {
        background: #f8fafc;
        color: #16324f;
      }
      .report-body blockquote {
        margin: 18px 0;
        padding: 14px 18px;
        border-left: 4px solid #d4af37;
        background: #fffaf0;
        color: #475569;
      }
      .report-body .highlight-box,
      .report-body .article-card {
        box-shadow: none;
      }
      .brand-footer {
        padding: 18px 38px 32px;
        font-size: 12px;
        color: #64748b;
        border-top: 1px solid #e2e8f0;
        background: linear-gradient(180deg, #fbfcfe 0%, #f3f6fa 100%);
      }
      @media (max-width: 768px) {
        body {
          background: #ffffff;
        }
        .brand-page {
          max-width: 100%;
          min-height: auto;
          box-shadow: none;
          margin: 0;
          border-radius: 0;
          border: none;
        }
        .brand-header {
          display: block;
          padding: 22px 18px 18px;
        }
        .brand-id {
          align-items: center;
        }
        .brand-logo,
        .brand-badge {
          width: 44px;
          height: 44px;
          border-radius: 12px;
        }
        .brand-name {
          font-size: 16px;
        }
        .brand-note,
        .report-date {
          font-size: 11px;
        }
        .report-meta {
          margin-top: 14px;
          text-align: left;
        }
        .overview-grid {
          grid-template-columns: 1fr;
        }
        .report-body {
          padding: 18px 18px 0;
        }
        .report-title {
          font-size: 14px;
        }
        .brand-footer {
          padding: 14px 18px 24px;
        }
        .hero {
          padding: 26px 18px 20px !important;
        }
        .hero h1 {
          font-size: 24px !important;
        }
        .hero p,
        .eyebrow {
          font-size: 12px !important;
        }
        .report-section {
          padding: 18px !important;
        }
        .report-section h2 {
          font-size: 17px !important;
        }
        .highlight-box {
          padding: 14px !important;
          border-radius: 12px !important;
        }
        .body-copy,
        .article-main ul,
        .article-main h3 {
          font-size: 14px !important;
          line-height: 1.7 !important;
        }
        .article-card {
          display: block !important;
          padding: 12px 0 !important;
        }
        .article-index {
          margin-bottom: 6px;
        }
      }
      @page {
        size: A4;
        margin: 18mm 14mm 18mm;
      }
    </style>
  </head>
  <body>
    <div class="brand-page">
      <header class="brand-header">
        <div class="brand-id">
          ${logoHtml}
          <div>
            <div class="brand-name">${branding.publisherName}</div>
            <div class="brand-note">이 문서는 ${branding.publisherName}가 발행한 분석 리포트입니다.</div>
            <div class="hero-kicker">${serviceLabel}</div>
            <div class="hero-summary">선택된 매체와 키워드를 기준으로 수집한 기사를 구조화해, 공유 URL에서도 가독성 좋게 확인할 수 있도록 정리했습니다.</div>
          </div>
        </div>
        <div class="report-meta">
          <div class="report-title">${output.title || 'AI 리포트'}</div>
          <div class="report-date">${dateLabel}</div>
        </div>
      </header>
      <main class="report-body">
        <section class="overview-grid">
          <div class="overview-card">
            <div class="overview-title">선택 매체</div>
            <div class="overview-value">${renderChips(selectedSourceNames, 'gold')}</div>
            <div class="overview-title" style="margin-top:16px;">실제 반영 매체</div>
            <div class="overview-value">${renderChips(matchedSourceNames)}</div>
          </div>
          <div class="overview-card">
            <div class="overview-title">키워드</div>
            <div class="overview-value">${renderChips(keywords)}</div>
            ${coverageHtml}
          </div>
        </section>
        ${bodyHtml}
      </main>
      <footer class="brand-footer">
        Issued by ${branding.publisherName}
      </footer>
    </div>
  </body>
  </html>`;
}

function buildInteractiveArticleReferenceSection(articles: any[]) {
  if (!Array.isArray(articles) || articles.length === 0) return '';

  return `
  <section class="report-section report-reference-section">
    <h2>참고 기사 원문</h2>
    <div class="reference-list">
      ${articles.map((article: any, index: number) => `
        <article class="reference-card">
          <h3>[${index + 1}] ${escapeHtml(article.title || '')}</h3>
          <div class="reference-meta">${escapeHtml(article.source || '')}</div>
          <div class="reference-actions">
            <button type="button" class="reference-link reference-link-primary article-ref-trigger" data-article-ref="${index}">원문 보기</button>
            ${article.url ? `<a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer" class="reference-link reference-link-secondary">원문 링크</a>` : ''}
          </div>
        </article>
      `).join('')}
    </div>
  </section>`;
}

function buildInteractiveBrandedShell({
  output,
  bodyHtml,
  headStyles,
  branding,
  articles,
}: {
  output: any;
  bodyHtml: string;
  headStyles: string;
  branding: ReportBranding;
  articles: any[];
}) {
  const dateLabel = resolveOutputDate(output);
  const serviceLabel = output.serviceMode === 'external' ? 'EXTERNAL DISTRIBUTION' : 'INTERNAL INTELLIGENCE';
  const logoHtml = branding.logoDataUrl
    ? `<img src="${branding.logoDataUrl}" alt="${branding.publisherName}" class="brand-logo" />`
    : `<div class="brand-badge">${escapeHtml(branding.publisherName.slice(0, 1))}</div>`;
  const modalPayload = escapeJsonForHtml(articles.map(buildArticleModalPayload));

  return `<!DOCTYPE html>
  <html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(output.title || '이음프라이빗에쿼티 리포트')}</title>
    <style>${headStyles}</style>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; background: #eef2f7; color: #0f172a; font-family: "Noto Sans KR Variable", "Malgun Gothic", sans-serif; font-size: 14px; }
      body[data-theme="dark"] { background: #0b1220; color: #e5e7eb; }
      body[data-font-size="xs"] { font-size: 14px; }
      body[data-font-size="sm"] { font-size: 15px; }
      body[data-font-size="md"] { font-size: 16px; }
      .reader-toolbar { position: sticky; top: 0; z-index: 40; display: flex; justify-content: space-between; gap: 12px; padding: 10px 14px; background: rgba(248,250,252,0.95); border-bottom: 1px solid rgba(148,163,184,0.18); backdrop-filter: blur(14px); }
      body[data-theme="dark"] .reader-toolbar { background: rgba(11,18,32,0.95); border-bottom-color: rgba(148,163,184,0.14); }
      .toolbar-group { display: flex; flex-wrap: wrap; gap: 8px; }
      .toolbar-button { appearance: none; border: 1px solid #dbe5ef; background: #ffffff; color: #16324f; border-radius: 999px; padding: 8px 12px; font-size: 12px; font-weight: 700; cursor: pointer; }
      body[data-theme="dark"] .toolbar-button { border-color: rgba(148,163,184,0.22); background: rgba(30,41,59,0.88); color: #f8fafc; }
      .brand-page { max-width: 980px; margin: 0 auto; background: #f8fbff; min-height: calc(100vh - 52px); }
      body[data-theme="dark"] .brand-page { background: #0f172a; }
      .brand-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 20px 18px 18px; background: linear-gradient(135deg, #10263d 0%, #183c5f 58%, #8f6a1f 140%); }
      .brand-id { display: flex; align-items: center; gap: 14px; min-width: 0; }
      .brand-logo { width: 44px; height: 44px; object-fit: contain; border-radius: 12px; background: rgba(255,255,255,0.96); padding: 6px; }
      .brand-badge { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: 12px; background: rgba(255,255,255,0.16); color: #ffffff; font-size: 20px; font-weight: 700; border: 1px solid rgba(255,255,255,0.24); }
      .brand-name { font-size: 17px; font-weight: 700; color: #ffffff; letter-spacing: -0.02em; }
      .report-meta { text-align: right; padding: 12px 14px; border-radius: 16px; background: rgba(6,13,24,0.22); border: 1px solid rgba(255,255,255,0.16); backdrop-filter: blur(8px); }
      .report-title { font-size: 15px; font-weight: 700; color: #ffffff; letter-spacing: -0.01em; }
      .report-date { margin-top: 4px; font-size: 12px; color: rgba(255,255,255,0.78); }
      .report-body { padding: 16px 14px 0; }
      .report-body > *:first-child { margin-top: 0 !important; }
      .report-body .container, .report-body .report-shell { max-width: none; margin: 0; box-shadow: none; }
      .report-body article.report-content, .report-body .report-shell { background: transparent !important; }
      .report-body .hero { border-radius: 20px; overflow: hidden; margin-bottom: 16px; box-shadow: 0 10px 24px rgba(22,50,79,0.10); }
      .report-body .hero h1, .report-body .hero h2, .report-body .hero h3, .report-body .hero p, .report-body .hero span, .report-body .hero li, .report-body .hero div { color: #ffffff !important; }
      .report-body .report-section, .report-body section { border-radius: 18px; background: #ffffff; border: 1px solid #dbe5ef; box-shadow: 0 8px 18px rgba(15,23,42,0.04); margin-bottom: 14px; }
      body[data-theme="dark"] .report-body .report-section, body[data-theme="dark"] .report-body section { background: #111827; border-color: rgba(148,163,184,0.16); box-shadow: none; }
      .report-body h1, .report-body h2, .report-body h3 { letter-spacing: -0.02em; }
      .report-body p, .report-body li { line-height: 1.62; color: #334155; }
      body[data-theme="dark"] .report-body p, body[data-theme="dark"] .report-body li, body[data-theme="dark"] .report-body h1, body[data-theme="dark"] .report-body h2, body[data-theme="dark"] .report-body h3 { color: #e5e7eb !important; }
      body[data-theme="dark"] .report-body *, body[data-theme="dark"] .report-body a, body[data-theme="dark"] .report-body strong, body[data-theme="dark"] .report-body span { color: #e5e7eb !important; }
      body[data-theme="dark"] .report-body div:not(.hero):not(.brand-header):not(.brand-id):not(.report-meta),
      body[data-theme="dark"] .report-body article,
      body[data-theme="dark"] .report-body aside,
      body[data-theme="dark"] .report-body blockquote,
      body[data-theme="dark"] .report-body ul,
      body[data-theme="dark"] .report-body ol { background-color: transparent; }
      body[data-theme="dark"] .report-body [style*="background"], body[data-theme="dark"] .report-body [style*="background-color"] { background: #111827 !important; color: #e5e7eb !important; }
      body[data-theme="dark"] .report-body [style*="border"] { border-color: rgba(148,163,184,0.18) !important; }
      .report-body ul, .report-body ol { padding-left: 1.25rem; }
      .report-body table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 16px; font-size: 14px; }
      .report-body th, .report-body td { border: 1px solid #e5e7eb; padding: 10px 12px; vertical-align: top; }
      .report-body th { background: #f8fafc; color: #16324f; }
      body[data-theme="dark"] .report-body th { background: #1f2937; color: #f8fafc; }
      body[data-theme="dark"] .report-body th, body[data-theme="dark"] .report-body td { border-color: rgba(148,163,184,0.14); }
      .article-ref-trigger { appearance: none; border: none; background: rgba(22,50,79,0.10); color: #16324f; border-radius: 999px; padding: 2px 8px; font: inherit; font-weight: 700; cursor: pointer; }
      body[data-theme="dark"] .article-ref-trigger { background: rgba(226,232,240,0.12); color: #f8fafc; }
      .reference-list { display: grid; gap: 10px; }
      .reference-card { border: 1px solid #dbe5ef; border-radius: 16px; background: linear-gradient(180deg, #fbfdff 0%, #f6f9fc 100%); padding: 12px 14px; }
      body[data-theme="dark"] .reference-card { background: #0f172a; border-color: rgba(148,163,184,0.16); }
      .reference-card h3 { margin: 0; font-size: 16px; color: #0f172a; }
      body[data-theme="dark"] .reference-card h3 { color: #f8fafc; }
      .reference-meta { margin-top: 4px; font-size: 12px; color: #64748b; line-height: 1.4; }
      .reference-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .reference-link { display: inline-flex; align-items: center; gap: 6px; border: none; border-radius: 999px; padding: 8px 12px; font-size: 12px; font-weight: 700; text-decoration: none; cursor: pointer; }
      .reference-link-primary { background: #16324f; color: #ffffff; }
      .reference-link-secondary { background: #eef4f9; color: #16324f; }
      body[data-theme="dark"] .reference-link-secondary { background: rgba(226,232,240,0.10); color: #f8fafc; }
      .brand-footer { padding: 18px 38px 32px; font-size: 12px; color: #64748b; border-top: 1px solid #e2e8f0; background: linear-gradient(180deg, #fbfcfe 0%, #f3f6fa 100%); }
      body[data-theme="dark"] .brand-footer { background: #0f172a; border-top-color: rgba(148,163,184,0.14); color: #94a3b8; }
      .article-modal { position: fixed; inset: 0; z-index: 60; display: none; align-items: center; justify-content: center; padding: 16px; background: rgba(15,23,42,0.62); }
      .article-modal.is-open { display: flex; }
      .article-modal-dialog { width: min(760px, 100%); max-height: min(84vh, 900px); overflow: hidden; display: flex; flex-direction: column; border-radius: 20px; background: #ffffff; box-shadow: 0 30px 60px rgba(15,23,42,0.24); }
      body[data-theme="dark"] .article-modal-dialog { background: #111827; color: #e5e7eb; }
      .article-modal-header, .article-modal-footer { padding: 18px 22px; border-bottom: 1px solid #e5e7eb; }
      .article-modal-footer { border-top: 1px solid #e5e7eb; border-bottom: none; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
      body[data-theme="dark"] .article-modal-header, body[data-theme="dark"] .article-modal-footer { border-color: rgba(148,163,184,0.14); }
      .article-modal-body { padding: 22px; overflow-y: auto; }
      .article-modal-meta { display: flex; flex-wrap: wrap; gap: 8px 12px; font-size: 12px; color: #64748b; }
      .article-modal-title { margin: 10px 0 0; font-size: 22px; line-height: 1.4; color: #0f172a; }
      body[data-theme="dark"] .article-modal-title { color: #f8fafc; }
      .article-modal-section + .article-modal-section { margin-top: 24px; }
      .article-modal-label { font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8; }
      .article-modal-summary { margin: 12px 0 0; padding-left: 18px; color: #334155; line-height: 1.8; }
      body[data-theme="dark"] .article-modal-summary { color: #cbd5e1; }
      .article-modal-content { margin-top: 12px; display: grid; gap: 14px; }
      .article-modal-content p { margin: 0; font-size: 14px; line-height: 1.68; color: #334155; }
      body[data-theme="dark"] .article-modal-content p { color: #e5e7eb; }
      .article-modal-close { appearance: none; border: none; background: #eef4f9; color: #16324f; font-size: 24px; line-height: 1; cursor: pointer; width: 42px; height: 42px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; }
      body[data-theme="dark"] .article-modal-close { background: rgba(226,232,240,0.12); color: #f8fafc; }
      .article-modal-open-link { color: #16324f; font-weight: 700; text-decoration: none; }
      body[data-theme="dark"] .article-modal-open-link { color: #f8fafc; }
      @media (min-width: 769px) {
        .brand-page { margin: 24px auto; border-radius: 28px; border: 1px solid rgba(22,50,79,0.08); box-shadow: 0 24px 54px rgba(15,23,42,0.08); }
        .brand-header { padding: 28px 30px 24px; }
        .report-body { padding: 24px 28px 0; }
        .report-meta { min-width: 210px; }
      }
      @media (max-width: 768px) {
        body { background: #ffffff; }
        body[data-theme="dark"] { background: #111827; }
        .reader-toolbar { padding: 10px 12px; }
        .toolbar-button { padding: 7px 10px; font-size: 11px; }
        .brand-page { max-width: 100%; min-height: auto; box-shadow: none; margin: 0; border-radius: 0; border: none; }
        .brand-header { display: block; padding: 22px 18px 18px; }
        .brand-logo, .brand-badge { width: 44px; height: 44px; border-radius: 12px; }
        .brand-name { font-size: 17px; }
        .report-meta { margin-top: 14px; text-align: left; }
        .report-body { padding: 18px 18px 0; }
        .brand-footer { padding: 14px 18px 24px; }
        .article-modal { padding: 14px; align-items: center; }
        .article-modal-dialog { width: min(100%, 720px); max-height: 82vh; height: auto; border-radius: 24px; }
        .article-modal-header, .article-modal-body, .article-modal-footer { padding-left: 16px; padding-right: 16px; }
        .article-modal-title { font-size: 18px; }
      }
      @page { size: A4; margin: 18mm 14mm 18mm; }
    </style>
  </head>
  <body>
    <div class="reader-toolbar">
      <div class="toolbar-group">
        <button type="button" class="toolbar-button" data-font-size="xs">A</button>
        <button type="button" class="toolbar-button" data-font-size="sm">A+</button>
        <button type="button" class="toolbar-button" data-font-size="md">A++</button>
      </div>
      <div class="toolbar-group">
        <button type="button" class="toolbar-button" data-theme-toggle>다크모드</button>
      </div>
    </div>
    <div class="brand-page">
      <header class="brand-header">
        <div class="brand-id">
          ${logoHtml}
          <div>
            <div class="brand-name">${escapeHtml(branding.publisherName)}</div>
          </div>
        </div>
        <div class="report-meta">
          <div class="report-title">${escapeHtml(output.title || 'AI 리포트')}</div>
          <div class="report-date">${dateLabel}</div>
        </div>
      </header>
      <main class="report-body">
        ${bodyHtml}
      </main>
      <footer class="brand-footer">Issued by ${escapeHtml(branding.publisherName)}</footer>
    </div>
    <div class="article-modal" id="article-modal" aria-hidden="true">
      <div class="article-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="article-modal-title">
        <div class="article-modal-header">
          <div class="article-modal-meta" id="article-modal-meta"></div>
          <h2 class="article-modal-title" id="article-modal-title"></h2>
        </div>
        <div class="article-modal-body">
          <section class="article-modal-section" id="article-modal-published-section" hidden>
            <div class="article-modal-label">발행시각</div>
            <div class="article-modal-content" id="article-modal-published"></div>
          </section>
          <section class="article-modal-section" id="article-modal-summary-section" hidden>
            <div class="article-modal-label">AI 요약</div>
            <ul class="article-modal-summary" id="article-modal-summary"></ul>
          </section>
          <section class="article-modal-section">
            <div class="article-modal-label">기사 원문</div>
            <div class="article-modal-content" id="article-modal-content"></div>
          </section>
        </div>
        <div class="article-modal-footer">
          <a id="article-modal-link" class="article-modal-open-link" target="_blank" rel="noopener noreferrer" hidden>원문 링크 열기</a>
          <button type="button" class="article-modal-close" data-close-modal aria-label="닫기">×</button>
        </div>
      </div>
    </div>
    <script id="article-modal-payload" type="application/json">${modalPayload}</script>
    <script>
      (function () {
        var payloadEl = document.getElementById('article-modal-payload');
        var payload = [];
        try { payload = JSON.parse(payloadEl ? payloadEl.textContent || '[]' : '[]'); } catch (error) { payload = []; }
        var modal = document.getElementById('article-modal');
        var metaEl = document.getElementById('article-modal-meta');
        var titleEl = document.getElementById('article-modal-title');
        var publishedSectionEl = document.getElementById('article-modal-published-section');
        var publishedEl = document.getElementById('article-modal-published');
        var summarySectionEl = document.getElementById('article-modal-summary-section');
        var summaryEl = document.getElementById('article-modal-summary');
        var contentEl = document.getElementById('article-modal-content');
        var linkEl = document.getElementById('article-modal-link');
        var title = document.querySelector('.report-title');
        if (title) document.title = title.textContent || document.title;

        function setFontSize(size) {
          document.body.setAttribute('data-font-size', size);
          try { localStorage.setItem('shared-report-font-size', size); } catch (error) {}
        }
        function setTheme(theme) {
          document.body.setAttribute('data-theme', theme);
          try { localStorage.setItem('shared-report-theme', theme); } catch (error) {}
        }
        function closeModal() {
          if (!modal) return;
          modal.classList.remove('is-open');
          modal.setAttribute('aria-hidden', 'true');
        }
        function openModal(index) {
          var article = payload[index];
          if (!article || !modal || !metaEl || !titleEl || !publishedSectionEl || !publishedEl || !summarySectionEl || !summaryEl || !contentEl || !linkEl) return;
          metaEl.innerHTML = '<span>' + (article.source || '') + '</span>' + (article.publishedAt ? '<span>' + article.publishedAt + '</span>' : '');
          titleEl.textContent = article.title || '제목 없음';
          publishedEl.innerHTML = '';
          if (article.publishedAt) {
            publishedSectionEl.hidden = false;
            var publishedP = document.createElement('p');
            publishedP.textContent = article.publishedAt;
            publishedEl.appendChild(publishedP);
          } else {
            publishedSectionEl.hidden = true;
          }
          summaryEl.innerHTML = '';
          (article.summary || []).forEach(function (line) {
            var li = document.createElement('li');
            li.textContent = line;
            summaryEl.appendChild(li);
          });
          summarySectionEl.hidden = (article.summary || []).length === 0;
          contentEl.innerHTML = '';
          var paragraphs = (article.contentParagraphs || []);
          if (!paragraphs.length) paragraphs = ['원문 전문이 저장되지 않은 기사입니다.'];
          paragraphs.forEach(function (paragraph) {
            var p = document.createElement('p');
            p.textContent = paragraph;
            contentEl.appendChild(p);
          });
          if (article.url) {
            linkEl.hidden = false;
            linkEl.href = article.url;
          } else {
            linkEl.hidden = true;
            linkEl.removeAttribute('href');
          }
          modal.classList.add('is-open');
          modal.setAttribute('aria-hidden', 'false');
        }

        document.querySelectorAll('[data-font-size]').forEach(function (button) {
          button.addEventListener('click', function () { setFontSize(button.getAttribute('data-font-size') || 'xs'); });
        });
        var themeToggle = document.querySelector('[data-theme-toggle]');
        if (themeToggle) {
          themeToggle.addEventListener('click', function () {
            var nextTheme = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            setTheme(nextTheme);
          });
        }
        document.addEventListener('click', function (event) {
          var target = event.target;
          if (!target || !target.closest) return;
          var trigger = target.closest('[data-article-ref]');
          if (trigger) {
            event.preventDefault();
            openModal(Number(trigger.getAttribute('data-article-ref')));
          }
        });
        if (modal) {
          modal.addEventListener('click', function (event) {
            if (event.target === modal || event.target.closest('[data-close-modal]')) closeModal();
          });
        }
        document.addEventListener('keydown', function (event) {
          if (event.key === 'Escape') closeModal();
        });
        try {
          setFontSize(localStorage.getItem('shared-report-font-size') || 'xs');
          setTheme(localStorage.getItem('shared-report-theme') || 'light');
        } catch (error) {
          setFontSize('xs');
          setTheme('light');
        }
      })();
    </script>
  </body>
  </html>`;
}

export async function getOutputHtmlDocument(output: any, articles?: any[]) {
  const loadedArticles = articles || await loadOutputArticles(output);
  const branding = await loadCompanyBranding(output.companyId);
  const rawHtml = extractHtmlPayload(output.htmlContent || output.rawOutput || '');
  const fallbackHtml = buildFallbackReportHtml(output, loadedArticles);
  const sourceHtml = rawHtml || fallbackHtml;

  const $ = load(sourceHtml);
  const bodyHtml = $('body').length > 0 ? $('body').html() || '' : sourceHtml;
  const sanitizedBodyHtml = sanitizeGeneratedReportBody(bodyHtml);
  const linkedBodyHtml = injectReferenceLinks(sanitizedBodyHtml, loadedArticles.length);
  const bodyHtmlWithReferences = `${linkedBodyHtml}${buildInteractiveArticleReferenceSection(loadedArticles)}`;
  const headStyles = $('style').toArray().map((element) => $.html(element)).join('\n');

  return buildInteractiveBrandedShell({
    output,
    bodyHtml: bodyHtmlWithReferences,
    headStyles,
    branding,
    articles: loadedArticles,
  });
}

export async function generateEmailHtml(output: any, articles?: any[]) {
  return getOutputHtmlDocument(output, articles);
}

export async function buildOutputHtmlAsset(outputId: string): Promise<OutputHtmlAsset> {
  const db = admin.firestore();
  const outputDoc = await db.collection('outputs').doc(outputId).get();
  if (!outputDoc.exists) {
    throw new Error(`Output ${outputId} not found`);
  }

  const output = { id: outputDoc.id, ...(outputDoc.data() as any) };
  const articles = await loadOutputArticles(output);
  const html = await getOutputHtmlDocument(output, articles);
  const fileStem = sanitizeFileName(output.title || `report-${outputId}`);

  return {
    output,
    articles,
    html,
    htmlFilename: `${fileStem}.html`,
  };
}

export async function buildReportPdfBuffer(output: any, articles?: any[]) {
  const html = await getOutputHtmlDocument(output, articles);
  const fontCss = await getFontCss();
  const pdfHtml = html.replace('</head>', `<style>${fontCss}</style></head>`);

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(pdfHtml, { waitUntil: 'networkidle0' });
    await page.emulateMediaType('screen');
    return Buffer.from(await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    }));
  } finally {
    await browser.close();
  }
}

export async function buildOutputAssetBundle(outputId: string) {
  const htmlAsset = await buildOutputHtmlAsset(outputId);
  const pdfBuffer = await buildReportPdfBuffer(htmlAsset.output, htmlAsset.articles);
  const fileStem = sanitizeFileName(htmlAsset.output.title || `report-${outputId}`);

  return {
    output: htmlAsset.output,
    articles: htmlAsset.articles,
    html: htmlAsset.html,
    pdfBuffer,
    htmlFilename: htmlAsset.htmlFilename,
    pdfFilename: `${fileStem}.pdf`,
  };
}

