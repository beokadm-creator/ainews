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
    return {
      publisherName: settings?.branding?.publisherName || settings?.companyName || '이음프라이빗에쿼티',
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
    : '<div class="meta-empty">설정되지 않음</div>';
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

export async function getOutputHtmlDocument(output: any, articles?: any[]) {
  const loadedArticles = articles || await loadOutputArticles(output);
  const branding = await loadCompanyBranding(output.companyId);
  const rawHtml = stripMarkdownCodeFence(output.htmlContent || output.rawOutput || '');
  const fallbackHtml = buildFallbackReportHtml(output, loadedArticles);
  const sourceHtml = rawHtml || fallbackHtml;

  const $ = load(sourceHtml);
  const bodyHtml = $('body').length > 0 ? $('body').html() || '' : sourceHtml;
  const headStyles = $('style').toArray().map((element) => $.html(element)).join('\n');

  return buildBrandedShell({
    output,
    bodyHtml,
    headStyles,
    branding,
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

