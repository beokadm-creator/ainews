import * as nodemailer from 'nodemailer';
import * as admin from 'firebase-admin';
import { retryWithBackoff } from '../utils/errorHandling';

async function getEmailConfig() {
  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    from: process.env.SMTP_FROM || '"EUM Private Equity" <noreply@eumpe.com>',
  };
}

// ─────────────────────────────────────────
// BUG-02 FIX: outputs 구조 기반으로 날짜/구조 재작성
// ─────────────────────────────────────────
function resolveOutputDate(output: any): string {
  try {
    if (output.createdAt?.toDate) return output.createdAt.toDate().toLocaleDateString('ko-KR');
    if (output.createdAt?.seconds) return new Date(output.createdAt.seconds * 1000).toLocaleDateString('ko-KR');
    if (output.createdAt) return new Date(output.createdAt).toLocaleDateString('ko-KR');
  } catch { /* ignore */ }
  return new Date().toLocaleDateString('ko-KR');
}

export async function generateEmailHtml(output: any, articles: any[]) {
  const structured = output.structuredOutput || {};
  const highlights: any[] = structured.highlights || [];
  const trends: any[] = structured.trends || []; // ★ Added
  const themes: any[] = structured.themes || [];
  const summary: string = structured.summary || output.rawOutput || '';
  const categories = [...new Set(articles.map((a: any) => a.category || '기타'))];
  const dateStr = resolveOutputDate(output);

  // Articles with index for matching AI references
  const articlesWithIndex = articles.map((a, i) => ({ ...a, displayIndex: i + 1 }));

  const highlightsHtml = highlights.map((h: any) => `
    <div class="highlight-box">
      <div style="display:flex; justify-content:space-between;">
        <div class="highlight-title">📌 ${h.title || ''}</div>
        ${h.articleIndex ? `<span style="font-size:10px; background:#1e3a5f; color:#fff; padding:2px 5px; border-radius:3px;">Source [${h.articleIndex}]</span>` : ''}
      </div>
      <div style="font-size:13px; color:#444; margin-top:5px;">${h.description || ''}</div>
    </div>
  `).join('');

  const trendsHtml = trends.map((t: any) => `
    <div class="highlight-box" style="border-left: 4px solid #60a5fa; background: #eff6ff;">
      <div style="display:flex; justify-content:space-between;">
        <div class="highlight-title" style="color: #1e40af;">📈 ${t.topic || ''}</div>
        <div style="display:flex; gap:3px;">
          ${(t.relatedArticles || []).map((idx: number) => `<span style="font-size:10px; background:#3b82f6; color:#fff; padding:2px 5px; border-radius:3px;">[${idx}]</span>`).join('')}
        </div>
      </div>
      <div style="font-size:13px; color:#1e3a8a; margin-top:5px;">${t.description || ''}</div>
    </div>
  `).join('');

  const themesHtml = themes.map((t: any) => `
    <div class="highlight-box">
      <div class="highlight-title">🔍 ${t.name || ''}</div>
      <div style="font-size:13px;">${t.description || ''}</div>
    </div>
  `).join('');

  const tabsHtml = categories.map((cat, idx) => `
    <input type="radio" name="tabs" id="tab${idx}" ${idx === 0 ? 'checked' : ''}>
    <label for="tab${idx}">${cat}</label>
  `).join('\n');

  const contentHtml = categories.map((cat, idx) => {
    const catArticles = articlesWithIndex.filter((a: any) => (a.category || '기타') === cat);
    const articlesHtml = catArticles.map((a: any) => `
      <div class="article-card" id="article-${a.displayIndex}">
        <h3 style="display:flex; align-items:flex-start; gap:8px;">
           <span style="background:#1e3a5f; color:#fff; padding:2px 6px; border-radius:4px; font-size:11px; white-space:nowrap;">[${a.displayIndex}]</span>
           <a href="${a.url || '#'}" target="_blank">${a.title || ''}</a>
        </h3>
        <div class="tags">
          <span class="tag" style="background:#f1f5f9;">${a.source || ''}</span>
          ${a.deal?.amount && a.deal.amount !== 'undisclosed' ? `<span class="tag">💰 ${a.deal.amount}</span>` : ''}
          ${a.companies?.target ? `<span class="tag">🏢 ${a.companies.target}</span>` : ''}
        </div>
        <ul>
          ${(a.summary || []).map((s: string) => `<li>${s}</li>`).join('')}
        </ul>
      </div>
    `).join('');
    return `<div class="tab-content" id="content${idx}">${articlesHtml}</div>`;
  }).join('\n');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif; background: #f5f7fa; color: #333; line-height: 1.6; }
        .container { max-width: 700px; margin: 0 auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .header { background: #1e3a5f; color: #fff; padding: 30px 20px; text-align: center; }
        .header h1 { margin: 0; color: #d4af37; font-size: 22px; }
        .header p { margin: 8px 0 0; opacity: 0.8; font-size: 13px; }
        .section { padding: 25px 20px; border-bottom: 1px solid #eee; }
        .section-title { color: #1e3a5f; border-left: 4px solid #1e3a5f; padding-left: 10px; margin-bottom: 20px; font-weight: bold; font-size: 17px; }
        .highlight-box { background: #f8f9fa; padding: 15px; border-radius: 8px; margin-bottom: 12px; border: 1px solid #e9ecef; }
        .highlight-title { font-weight: bold; color: #1e3a5f; font-size: 15px; }
        .tabs-container { padding: 20px; }
        input[name="tabs"] { display: none; }
        label { display: inline-block; padding: 10px 15px; background: #f1f5f9; cursor: pointer; border-radius: 6px 6px 0 0; margin-right: 4px; font-weight: bold; color: #64748b; font-size: 12px; }
        input[name="tabs"]:checked + label { background: #1e3a5f; color: #fff; }
        .tab-content { display: none; padding: 15px 0; border-top: 2px solid #1e3a5f; }
        ${categories.map((_, idx) => `#tab${idx}:checked ~ #content${idx} { display: block; }`).join('\n')}
        .article-card { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px dashed #eee; }
        .article-card h3 { margin: 0 0 8px 0; font-size: 15px; display: flex; align-items: flex-start; }
        .article-card a { color: #1e3a5f; text-decoration: none; }
        .article-card ul { margin: 10px 0 0; padding-left: 20px; color: #475569; font-size: 13px; }
        .tag { display: inline-block; background: #f1f5f9; padding: 3px 8px; border-radius: 5px; font-size: 11px; color: #64748b; margin-right: 5px; margin-bottom: 5px; }
        .footer { background: #f8f9fa; padding: 20px; text-align: center; font-size: 11px; color: #94a3b8; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${output.title || 'EUM PE AI 리포트'}</h1>
          <p>${dateStr} · ${output.articleCount || articles.length}개의 주요 뉴스 분석</p>
        </div>
        ${summary ? `
        <div class="section">
          <h2 class="section-title">핵심 요약 (Executive Summary)</h2>
          <div style="font-size: 14px; color: #334155; white-space: pre-wrap;">${summary}</div>
        </div>` : ''}
        ${highlights.length > 0 ? `
        <div class="section">
          <h2 class="section-title">주요 뉴스 (Highlights)</h2>
          ${highlightsHtml}
        </div>` : ''}
        ${trends.length > 0 ? `
        <div class="section">
          <h2 class="section-title">최신 시장 동향 (Market Trends)</h2>
          ${trendsHtml}
        </div>` : ''}
        ${themes.length > 0 ? `
        <div class="section">
          <h2 class="section-title">주요 테마 (Key Themes)</h2>
          ${themesHtml}
        </div>` : ''}
        <div class="tabs-container">
          <h2 class="section-title">부문별 상세 기사 (Reference Articles)</h2>
          ${tabsHtml}
          ${contentHtml}
        </div>
        <div class="footer">
          본 메일은 시스템에서 자동 발송된 리포트이며 발신 전용입니다.<br>
          © Eum Private Equity. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `;
}

export async function sendBriefingEmails(outputId: string) {
  return sendOutputEmails(outputId);
}

export async function sendOutputEmails(
  outputId: string,
  explicitRecipients?: string[],
  options?: {
    subjectPrefix?: string;
    markAsField?: string;
    metadata?: Record<string, any>;
  }
) {
  const db = admin.firestore();

  try {
    const config = await getEmailConfig();
    if (!config.auth.user || !config.auth.pass) {
      throw new Error('SMTP credentials not configured');
    }

    const transporter = nodemailer.createTransport(config);

    // BUG-02 FIX: outputs 컬렉션 사용
    const outputDoc = await db.collection('outputs').doc(outputId).get();
    if (!outputDoc.exists) {
      throw new Error(`Output ${outputId} not found`);
    }
    const output = outputDoc.data()!;

    let articles: any[] = [];
    if (Array.isArray(output.articleIds) && output.articleIds.length > 0) {
      const articleDocs = await Promise.all(
        output.articleIds.map((articleId: string) => db.collection('articles').doc(articleId).get())
      );
      articles = articleDocs.filter((doc) => doc.exists).map((doc) => doc.data());
    } else {
      const articlesSnapshot = await db.collection('articles')
        .where('publishedInOutputId', '==', outputId)
        .get();
      articles = articlesSnapshot.docs.map(doc => doc.data());
    }

    const html = await generateEmailHtml(output, articles);

    // Company-scoped subscribers from companySettings
    const companyId = output.companyId;
    let subscriberEmails: string[] = [];

    if (companyId) {
      const settingsDoc = await db.collection('companySettings').doc(companyId).get();
      const settingsData = settingsDoc.data() as any;
      subscriberEmails = settingsData?.subscriberEmails || [];
    }

    // Fallback: global subscribers collection (legacy)
    if (subscriberEmails.length === 0) {
      const subscribersSnapshot = await db.collection('subscribers').where('active', '==', true).get();
      subscriberEmails = subscribersSnapshot.docs.map(doc => doc.data().email).filter(Boolean);
    }

    if (Array.isArray(explicitRecipients) && explicitRecipients.length > 0) {
      subscriberEmails = explicitRecipients.filter(Boolean);
    }

    if (subscriberEmails.length === 0) {
      console.log('No active subscribers found.');
      return { success: true, sentCount: 0, message: 'No subscribers configured' };
    }

    const info = await retryWithBackoff(() => transporter.sendMail({
      from: config.from,
      bcc: subscriberEmails,
      subject: `${options?.subjectPrefix || '[EUM PE]'} ${output.title || 'AI News Report'} (${resolveOutputDate(output)})`,
      html,
    }));

    const markField = options?.markAsField || 'emailSentAt';
    await outputDoc.ref.set({
      emailSent: true,
      emailSuccessCount: subscriberEmails.length,
      [markField]: admin.firestore.FieldValue.serverTimestamp(),
      ...(options?.metadata || {}),
    }, { merge: true });

    return { success: true, sentCount: subscriberEmails.length, messageId: info.messageId };
  } catch (error) {
    console.error('Error sending briefing emails:', error);
    throw error;
  }
}

export async function sendErrorNotification(errorInfo: {
  severity: string;
  category: string;
  message: string;
  context?: Record<string, any>;
}): Promise<void> {
  try {
    const config = await getEmailConfig();
    if (!config.auth.user || !config.auth.pass) return;

    const transporter = nodemailer.createTransport(config);
    const adminEmails = process.env.ADMIN_EMAILS?.split(',') || ['admin@eumpe.com'];
    const severityEmoji = errorInfo.severity === 'critical' ? '🔴' : errorInfo.severity === 'high' ? '🟠' : '🟡';

    const html = `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #1e3a5f; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">${severityEmoji} EUM News System Error</h2>
        </div>
        <div style="background: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; border-top: none;">
          <p><strong>Severity:</strong> ${errorInfo.severity.toUpperCase()}</p>
          <p><strong>Category:</strong> ${errorInfo.category}</p>
          <p><strong>Time:</strong> ${new Date().toLocaleString('ko-KR')}</p>
          <p><strong>Message:</strong> <span style="color:#dc3545;">${errorInfo.message}</span></p>
          ${errorInfo.context ? `<pre style="font-size:12px;overflow-x:auto;">${JSON.stringify(errorInfo.context, null, 2)}</pre>` : ''}
        </div>
      </div>
    `;

    await transporter.sendMail({
      from: config.from,
      to: adminEmails,
      subject: `[${severityEmoji} EUM] ${errorInfo.severity.toUpperCase()} - ${errorInfo.message.substring(0, 50)}`,
      html,
    });
  } catch {
    // non-critical
  }
}
