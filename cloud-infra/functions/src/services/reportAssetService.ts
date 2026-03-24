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
        background: #eef2f6;
        color: #111827;
        font-family: "Noto Sans KR Variable", "Malgun Gothic", sans-serif;
      }
      .brand-page {
        max-width: 980px;
        margin: 0 auto;
        background: #ffffff;
        min-height: 100vh;
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.08);
      }
      .brand-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        padding: 24px 36px;
        border-bottom: 1px solid #dbe4ef;
        background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
      }
      .brand-id {
        display: flex;
        align-items: center;
        gap: 14px;
        min-width: 0;
      }
      .brand-logo {
        width: 52px;
        height: 52px;
        object-fit: contain;
        border-radius: 14px;
        background: #fff;
      }
      .brand-badge {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 52px;
        height: 52px;
        border-radius: 14px;
        background: #16324f;
        color: #fff;
        font-size: 24px;
        font-weight: 700;
      }
      .brand-name {
        font-size: 18px;
        font-weight: 700;
        color: #16324f;
      }
      .brand-note {
        margin-top: 4px;
        font-size: 12px;
        color: #64748b;
      }
      .report-meta {
        text-align: right;
      }
      .report-title {
        font-size: 15px;
        font-weight: 700;
        color: #16324f;
      }
      .report-date {
        margin-top: 4px;
        font-size: 12px;
        color: #64748b;
      }
      .report-body {
        padding: 0;
      }
      .report-body .container,
      .report-body .report-shell {
        max-width: none;
        margin: 0;
        box-shadow: none;
      }
      .brand-footer {
        padding: 16px 36px 32px;
        font-size: 12px;
        color: #94a3b8;
        border-top: 1px solid #e5e7eb;
        background: #fafbfd;
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
          </div>
        </div>
        <div class="report-meta">
          <div class="report-title">${output.title || 'AI 리포트'}</div>
          <div class="report-date">${dateLabel}</div>
        </div>
      </header>
      <main class="report-body">
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
  const db = admin.firestore();
  const outputDoc = await db.collection('outputs').doc(outputId).get();
  if (!outputDoc.exists) {
    throw new Error(`Output ${outputId} not found`);
  }

  const output = { id: outputDoc.id, ...(outputDoc.data() as any) };
  const articles = await loadOutputArticles(output);
  const html = await getOutputHtmlDocument(output, articles);
  const pdfBuffer = await buildReportPdfBuffer(output, articles);
  const fileStem = sanitizeFileName(output.title || `report-${outputId}`);

  return {
    output,
    articles,
    html,
    pdfBuffer,
    htmlFilename: `${fileStem}.html`,
    pdfFilename: `${fileStem}.pdf`,
  };
}
