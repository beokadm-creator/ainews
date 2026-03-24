import * as admin from 'firebase-admin';
import PDFDocument from 'pdfkit';
import { load } from 'cheerio';
import * as path from 'path';
import { cleanHtmlContent, fixEncodingIssues } from '../utils/encodingUtils';

const PDF_FONT_REGULAR = path.resolve(
  __dirname,
  '../../node_modules/@fontsource/noto-sans-kr/files/noto-sans-kr-0-400-normal.woff',
);
const PDF_FONT_BOLD = path.resolve(
  __dirname,
  '../../node_modules/@fontsource/noto-sans-kr/files/noto-sans-kr-0-700-normal.woff',
);

type PdfBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'subheading'; text: string };

interface PdfSection {
  title: string;
  blocks: PdfBlock[];
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

function buildFallbackReportHtml(output: any, articles: any[]) {
  const structured = output.structuredOutput || {};
  const highlights: any[] = structured.highlights || [];
  const trends: any[] = structured.trends || [];
  const themes: any[] = structured.themes || [];
  const summary: string = structured.summary || output.rawOutput || '';
  const categories = [...new Set(articles.map((a: any) => a.category || 'Reference Articles'))];
  const dateStr = resolveOutputDate(output);
  const articlesWithIndex = articles.map((a, i) => ({ ...a, displayIndex: i + 1 }));

  const highlightsHtml = highlights.map((h: any) => `
    <div class="highlight-box">
      <div style="display:flex; justify-content:space-between; gap:12px;">
        <div class="highlight-title">${h.title || ''}</div>
        ${h.articleIndex ? `<span class="inline-ref">[${h.articleIndex}]</span>` : ''}
      </div>
      <div class="body-copy">${h.description || ''}</div>
    </div>
  `).join('');

  const trendsHtml = trends.map((t: any) => `
    <div class="highlight-box tone-blue">
      <div style="display:flex; justify-content:space-between; gap:12px;">
        <div class="highlight-title">${t.topic || ''}</div>
        <div style="display:flex; gap:4px; flex-wrap:wrap;">
          ${(t.relatedArticles || []).map((idx: number) => `<span class="inline-ref">[${idx}]</span>`).join('')}
        </div>
      </div>
      <div class="body-copy">${t.description || ''}</div>
    </div>
  `).join('');

  const themesHtml = themes.map((t: any) => `
    <div class="highlight-box">
      <div class="highlight-title">${t.name || ''}</div>
      <div class="body-copy">${t.description || ''}</div>
    </div>
  `).join('');

  const contentHtml = categories.map((cat) => {
    const catArticles = articlesWithIndex.filter((a: any) => (a.category || 'Reference Articles') === cat);
    const articlesHtml = catArticles.map((a: any) => `
      <div class="article-card" id="article-${a.displayIndex}">
        <h3>
          <span class="inline-ref">[${a.displayIndex}]</span>
          <a href="${a.url || '#'}" target="_blank" rel="noopener noreferrer">${a.title || ''}</a>
        </h3>
        <div class="tags">
          <span class="tag">${a.source || ''}</span>
          ${a.deal?.amount && a.deal.amount !== 'undisclosed' ? `<span class="tag">${a.deal.amount}</span>` : ''}
          ${a.companies?.target ? `<span class="tag">${a.companies.target}</span>` : ''}
        </div>
        <ul>
          ${(a.summary || []).map((s: string) => `<li>${s}</li>`).join('')}
        </ul>
      </div>
    `).join('');

    return `
      <section class="section-block">
        <h2>${cat}</h2>
        ${articlesHtml || '<p class="body-copy">No related articles.</p>'}
      </section>
    `;
  }).join('');

  return `<!DOCTYPE html>
  <html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>${output.title || 'EUM PE AI Report'}</title>
    <style>
      body { font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; background: #f3f5f8; color: #1f2937; margin: 0; }
      .container { max-width: 820px; margin: 0 auto; background: #ffffff; }
      .header { background: linear-gradient(135deg, #17324f 0%, #23486f 100%); color: #ffffff; padding: 40px 36px 30px; }
      .eyebrow { display:inline-block; padding: 6px 10px; border-radius: 999px; background: rgba(255,255,255,0.12); font-size: 12px; letter-spacing: 0.04em; }
      .header h1 { margin: 18px 0 10px; color: #f0d07a; font-size: 28px; line-height: 1.25; }
      .header p { margin: 0; font-size: 14px; opacity: 0.92; }
      .section-block { padding: 28px 36px; border-bottom: 1px solid #e5e7eb; }
      .section-block h2 { margin: 0 0 14px; color: #17324f; font-size: 20px; }
      .highlight-box { background: #f8fafc; border: 1px solid #e5e7eb; border-left: 4px solid #17324f; border-radius: 14px; padding: 16px; margin-bottom: 12px; }
      .tone-blue { background: #eff6ff; border-left-color: #2563eb; }
      .highlight-title { font-size: 16px; font-weight: 700; color: #17324f; }
      .body-copy { font-size: 14px; line-height: 1.75; color: #334155; margin-top: 8px; white-space: pre-wrap; }
      .inline-ref { display:inline-block; padding: 2px 7px; border-radius: 999px; background: #17324f; color:#fff; font-size: 11px; white-space: nowrap; }
      .article-card { padding: 16px 0; border-top: 1px dashed #d1d5db; }
      .article-card:first-of-type { border-top: none; padding-top: 0; }
      .article-card h3 { margin: 0 0 10px; font-size: 16px; color: #17324f; display:flex; gap:8px; align-items:flex-start; }
      .article-card a { color: inherit; text-decoration: none; }
      .article-card ul { margin: 10px 0 0 18px; padding: 0; color: #475569; }
      .article-card li { margin-bottom: 6px; line-height: 1.65; }
      .tags { display:flex; gap:6px; flex-wrap:wrap; }
      .tag { display:inline-block; padding: 4px 8px; border-radius: 999px; background: #eef2f7; color: #475569; font-size: 12px; }
      .footer { padding: 24px 36px 36px; font-size: 12px; color: #94a3b8; background: #f8fafc; }
    </style>
  </head>
  <body>
    <div class="container">
      <header class="header">
        <span class="eyebrow">EUM PRIVATE EQUITY REPORT</span>
        <h1>${output.title || 'EUM PE AI Report'}</h1>
        <p>${dateStr} · ${output.articleCount || articles.length} articles analyzed</p>
      </header>
      ${summary ? `
        <section class="section-block">
          <h2>Executive Summary</h2>
          <div class="body-copy">${summary}</div>
        </section>
      ` : ''}
      ${highlights.length > 0 ? `
        <section class="section-block">
          <h2>Highlights</h2>
          ${highlightsHtml}
        </section>
      ` : ''}
      ${trends.length > 0 ? `
        <section class="section-block">
          <h2>Market Trends</h2>
          ${trendsHtml}
        </section>
      ` : ''}
      ${themes.length > 0 ? `
        <section class="section-block">
          <h2>Key Themes</h2>
          ${themesHtml}
        </section>
      ` : ''}
      ${contentHtml}
      <footer class="footer">
        This report was generated by the EUM News system.
      </footer>
    </div>
  </body>
  </html>`;
}

export async function loadOutputArticles(output: any) {
  const db = admin.firestore();
  let articles: any[] = [];

  if (Array.isArray(output.articleIds) && output.articleIds.length > 0) {
    const articleDocs = await Promise.all(
      output.articleIds.map((articleId: string) => db.collection('articles').doc(articleId).get()),
    );
    articles = articleDocs
      .filter((doc) => doc.exists)
      .map((doc) => ({ id: doc.id, ...(doc.data() as any) }));
  } else {
    const articlesSnapshot = await db.collection('articles')
      .where('publishedInOutputId', '==', output.id)
      .get();
    articles = articlesSnapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as any) }));
  }

  return articles;
}

export async function getOutputHtmlDocument(output: any, articles?: any[]) {
  const loadedArticles = articles || await loadOutputArticles(output);
  const rawHtml = stripMarkdownCodeFence(output.htmlContent || output.rawOutput || '');

  if (rawHtml && /<html[\s>]|<!DOCTYPE html>/i.test(rawHtml)) {
    return rawHtml;
  }

  if (rawHtml && /<(article|section|div|h1|h2|p|ul|ol|li)[\s>]/i.test(rawHtml)) {
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8" /><title>${output.title || 'EUM PE 리포트'}</title></head><body>${rawHtml}</body></html>`;
  }

  return buildFallbackReportHtml(output, loadedArticles);
}

export async function generateEmailHtml(output: any, articles?: any[]) {
  const loadedArticles = articles || await loadOutputArticles(output);
  return getOutputHtmlDocument(output, loadedArticles);
}

function extractSectionsFromHtml(html: string) {
  const $ = load(html);
  const title = sanitizeText($('h1').first().text()) || 'EUM PE 분석 리포트';
  const sections: PdfSection[] = [];

  $('section').each((_, element) => {
    const node = $(element);
    const heading = sanitizeText(node.find('h2').first().text()) || sanitizeText(node.find('h1').first().text()) || '섹션';
    const blocks: PdfBlock[] = [];

    node.children().each((__, child) => {
      const childNode = $(child);
      const tag = child.tagName?.toLowerCase();
      if (!tag || tag === 'h1' || tag === 'h2') {
        return;
      }

      if (tag === 'h3' || tag === 'h4') {
        const text = sanitizeText(childNode.text());
        if (text) blocks.push({ type: 'subheading', text });
        return;
      }

      if (tag === 'ul' || tag === 'ol') {
        const items = childNode.find('li')
          .toArray()
          .map((item) => sanitizeText($(item).text()))
          .filter(Boolean);
        if (items.length > 0) blocks.push({ type: 'list', items });
        return;
      }

      const text = sanitizeText(childNode.text());
      if (text) {
        blocks.push({ type: 'paragraph', text });
      }
    });

    if (blocks.length > 0) {
      sections.push({ title: heading, blocks });
    }
  });

  if (sections.length === 0) {
    const bodyText = sanitizeText($.root().text());
    const fallbackBlocks = bodyText
      .split(/\n{2,}/)
      .map((chunk) => sanitizeText(chunk))
      .filter(Boolean)
      .map((text) => ({ type: 'paragraph', text } as PdfBlock));

    if (fallbackBlocks.length > 0) {
      sections.push({ title: '리포트 본문', blocks: fallbackBlocks });
    }
  }

  return { title, sections };
}

function ensureSpace(doc: PDFKit.PDFDocument, minHeight: number) {
  if (doc.y + minHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
}

function drawParagraph(doc: PDFKit.PDFDocument, text: string, indent = 0) {
  doc
    .font('ReportRegular')
    .fontSize(11)
    .fillColor('#334155')
    .text(text, doc.page.margins.left + indent, doc.y, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right - indent,
      lineGap: 4,
    });
  doc.moveDown(0.8);
}

function sanitizeFileName(value: string) {
  return (value || 'report')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'report';
}

export async function buildReportPdfBuffer(output: any, articles?: any[]) {
  const loadedArticles = articles || await loadOutputArticles(output);
  const html = await getOutputHtmlDocument(output, loadedArticles);
  const { title, sections } = extractSectionsFromHtml(html);
  const dateLabel = resolveOutputDate(output);

  return new Promise<Buffer>((resolve, reject) => {
    const buffers: Buffer[] = [];
    const doc = new PDFDocument({
      size: 'A4',
      margin: 52,
      bufferPages: true,
      info: {
        Title: title,
        Author: 'EUM News',
        Subject: output.title || title,
      },
    });

    doc.on('data', (chunk) => buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    doc.registerFont('ReportRegular', PDF_FONT_REGULAR);
    doc.registerFont('ReportBold', PDF_FONT_BOLD);
    doc.font('ReportRegular');

    doc
      .rect(0, 0, doc.page.width, 170)
      .fill('#17324f');

    doc
      .fillColor('#f0d07a')
      .font('ReportBold')
      .fontSize(28)
      .text(output.title || title, 52, 58, {
        width: doc.page.width - 104,
        lineGap: 6,
      });

    doc
      .fillColor('#e2e8f0')
      .font('ReportRegular')
      .fontSize(11)
      .text(`작성일 ${dateLabel}`, 52, 128);

    doc
      .font('ReportRegular')
      .fontSize(11)
      .text(`분석 기사 ${loadedArticles.length}건`, 140, 128);

    doc.y = 198;
    doc
      .fillColor('#64748b')
      .font('ReportRegular')
      .fontSize(10)
      .text('EUM PRIVATE EQUITY INTERNAL ANALYSIS', 52, doc.y);
    doc.moveDown(1.2);

    for (const section of sections) {
      ensureSpace(doc, 60);
      doc
        .fillColor('#17324f')
        .font('ReportBold')
        .fontSize(18)
        .text(section.title, {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        });
      doc.moveDown(0.5);

      doc
        .save()
        .moveTo(doc.page.margins.left, doc.y)
        .lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .lineWidth(1)
        .strokeColor('#dbe4ef')
        .stroke()
        .restore();
      doc.moveDown(0.8);

      for (const block of section.blocks) {
        if (block.type === 'subheading') {
          ensureSpace(doc, 28);
          doc
            .font('ReportBold')
            .fontSize(13)
            .fillColor('#1e293b')
            .text(block.text, {
              width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
            });
          doc.moveDown(0.4);
          continue;
        }

        if (block.type === 'list') {
          for (const item of block.items) {
            ensureSpace(doc, 32);
            doc
              .font('ReportBold')
              .fontSize(11)
              .fillColor('#17324f')
              .text('•', doc.page.margins.left, doc.y + 1);
            drawParagraph(doc, item, 14);
          }
          continue;
        }

        ensureSpace(doc, 40);
        drawParagraph(doc, block.text);
      }

      doc.moveDown(0.8);
    }

    if (loadedArticles.length > 0) {
      doc.addPage();
      doc
        .fillColor('#17324f')
        .font('ReportBold')
        .fontSize(20)
        .text('참고 기사 목록', {
          width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        });
      doc.moveDown(1);

      loadedArticles.forEach((article, index) => {
        ensureSpace(doc, 64);
        doc
          .font('ReportBold')
          .fontSize(12)
          .fillColor('#111827')
          .text(`[${index + 1}] ${sanitizeText(article.title || '제목 없음')}`, {
            width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
          });
        doc.moveDown(0.25);

        const meta = [
          sanitizeText(article.source || ''),
          article.publishedAt?.toDate ? article.publishedAt.toDate().toLocaleString('ko-KR') : sanitizeText(String(article.publishedAt || '')),
        ].filter(Boolean).join(' · ');

        if (meta) {
          doc
            .font('ReportRegular')
            .fontSize(10)
            .fillColor('#64748b')
            .text(meta);
          doc.moveDown(0.2);
        }

        const summaryText = Array.isArray(article.summary) && article.summary.length > 0
          ? article.summary.map((item: string) => sanitizeText(item)).filter(Boolean).join(' ')
          : sanitizeText(article.content || '');

        if (summaryText) {
          drawParagraph(doc, summaryText.slice(0, 520));
        }
      });
    }

    const pageRange = doc.bufferedPageRange();
    for (let pageIndex = 0; pageIndex < pageRange.count; pageIndex += 1) {
      doc.switchToPage(pageIndex);
      doc
        .font('ReportRegular')
        .fontSize(9)
        .fillColor('#94a3b8')
        .text(
          `${pageIndex + 1} / ${pageRange.count}`,
          0,
          doc.page.height - 28,
          { align: 'center' },
        );
    }

    doc.end();
  });
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
