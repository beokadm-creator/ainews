"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateEmailHtml = generateEmailHtml;
exports.sendBriefingEmails = sendBriefingEmails;
exports.sendErrorNotification = sendErrorNotification;
const nodemailer = __importStar(require("nodemailer"));
const admin = __importStar(require("firebase-admin"));
const errorHandling_1 = require("../utils/errorHandling");
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
function resolveOutputDate(output) {
    try {
        if (output.createdAt?.toDate)
            return output.createdAt.toDate().toLocaleDateString('ko-KR');
        if (output.createdAt?.seconds)
            return new Date(output.createdAt.seconds * 1000).toLocaleDateString('ko-KR');
        if (output.createdAt)
            return new Date(output.createdAt).toLocaleDateString('ko-KR');
    }
    catch { /* ignore */ }
    return new Date().toLocaleDateString('ko-KR');
}
async function generateEmailHtml(output, articles) {
    const structured = output.structuredOutput || {};
    const highlights = structured.highlights || [];
    const themes = structured.themes || [];
    const summary = structured.summary || output.rawOutput || '';
    const categories = [...new Set(articles.map((a) => a.category || '기타'))];
    const dateStr = resolveOutputDate(output);
    const highlightsHtml = highlights.map((h) => `
    <div class="highlight-box">
      <div class="highlight-title">📌 ${h.title || ''}</div>
      <div>${h.description || ''}</div>
    </div>
  `).join('');
    const themesHtml = themes.map((t) => `
    <div class="highlight-box">
      <div class="highlight-title">🔍 ${t.name || ''}</div>
      <div>${t.description || ''}</div>
    </div>
  `).join('');
    const tabsHtml = categories.map((cat, idx) => `
    <input type="radio" name="tabs" id="tab${idx}" ${idx === 0 ? 'checked' : ''}>
    <label for="tab${idx}">${cat}</label>
  `).join('\n');
    const contentHtml = categories.map((cat, idx) => {
        const catArticles = articles.filter((a) => (a.category || '기타') === cat);
        const articlesHtml = catArticles.map((a) => `
      <div class="article-card">
        <h3><a href="${a.url || '#'}" target="_blank">${a.title || ''}</a></h3>
        <div class="tags">
          ${a.deal?.amount && a.deal.amount !== 'undisclosed' ? `<span class="tag">💰 ${a.deal.amount}</span>` : ''}
          ${a.companies?.target ? `<span class="tag">🏢 ${a.companies.target}</span>` : ''}
        </div>
        <ul>
          ${(a.summary || []).map((s) => `<li>${s}</li>`).join('')}
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
        .section { padding: 20px; border-bottom: 1px solid #eee; }
        .section-title { color: #1e3a5f; border-left: 4px solid #d4af37; padding-left: 10px; margin-bottom: 15px; font-size: 15px; }
        .highlight-box { background: #f8f9fa; padding: 14px; border-radius: 6px; margin-bottom: 10px; border: 1px solid #e9ecef; }
        .highlight-title { font-weight: bold; color: #1e3a5f; margin-bottom: 4px; }
        .tabs-container { padding: 20px; }
        input[name="tabs"] { display: none; }
        label { display: inline-block; padding: 8px 13px; background: #eee; cursor: pointer; border-radius: 4px 4px 0 0; margin-right: 4px; font-weight: bold; color: #666; font-size: 12px; }
        input[name="tabs"]:checked + label { background: #1e3a5f; color: #fff; }
        .tab-content { display: none; padding: 15px 0; border-top: 2px solid #1e3a5f; }
        ${categories.map((_, idx) => `#tab${idx}:checked ~ #content${idx} { display: block; }`).join('\n')}
        .article-card { margin-bottom: 18px; padding-bottom: 18px; border-bottom: 1px dashed #eee; }
        .article-card h3 { margin: 0 0 8px 0; font-size: 14px; }
        .article-card a { color: #1e3a5f; text-decoration: none; }
        .article-card ul { margin: 8px 0 0; padding-left: 18px; color: #555; font-size: 13px; }
        .tag { display: inline-block; background: #e9ecef; padding: 2px 7px; border-radius: 10px; font-size: 11px; color: #495057; margin-right: 4px; margin-bottom: 4px; }
        .footer { background: #f8f9fa; padding: 16px; text-align: center; font-size: 11px; color: #999; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${output.title || 'EUM PE AI Report'}</h1>
          <p>${dateStr} · ${output.type || 'analysis_report'} · Articles: ${output.articleCount || articles.length}</p>
        </div>
        ${summary ? `
        <div class="section">
          <h2 class="section-title">Executive Summary</h2>
          <p>${summary}</p>
        </div>` : ''}
        ${highlights.length > 0 ? `
        <div class="section">
          <h2 class="section-title">Highlights</h2>
          ${highlightsHtml}
        </div>` : ''}
        ${themes.length > 0 ? `
        <div class="section">
          <h2 class="section-title">Key Themes</h2>
          ${themesHtml}
        </div>` : ''}
        ${articles.length > 0 ? `
        <div class="tabs-container">
          <h2 class="section-title">Articles by Sector</h2>
          ${tabsHtml}
          ${contentHtml}
        </div>` : ''}
        <div class="footer">
          본 메일은 발신 전용입니다.<br>
          © Eum Private Equity. All rights reserved.
        </div>
      </div>
    </body>
    </html>
  `;
}
async function sendBriefingEmails(outputId) {
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
        const output = outputDoc.data();
        const articlesSnapshot = await db.collection('articles')
            .where('publishedInOutputId', '==', outputId)
            .get();
        const articles = articlesSnapshot.docs.map(doc => doc.data());
        const html = await generateEmailHtml(output, articles);
        // Company-scoped subscribers from companySettings
        const companyId = output.companyId;
        let subscriberEmails = [];
        if (companyId) {
            const settingsDoc = await db.collection('companySettings').doc(companyId).get();
            const settingsData = settingsDoc.data();
            subscriberEmails = settingsData?.subscriberEmails || [];
        }
        // Fallback: global subscribers collection (legacy)
        if (subscriberEmails.length === 0) {
            const subscribersSnapshot = await db.collection('subscribers').where('active', '==', true).get();
            subscriberEmails = subscribersSnapshot.docs.map(doc => doc.data().email).filter(Boolean);
        }
        if (subscriberEmails.length === 0) {
            console.log('No active subscribers found.');
            return { success: true, sentCount: 0, message: 'No subscribers configured' };
        }
        const info = await (0, errorHandling_1.retryWithBackoff)(() => transporter.sendMail({
            from: config.from,
            bcc: subscriberEmails,
            subject: `[EUM PE] AI News Report (${resolveOutputDate(output)})`,
            html,
        }));
        await outputDoc.ref.update({
            emailSent: true,
            emailSentAt: admin.firestore.FieldValue.serverTimestamp(),
            emailSuccessCount: subscriberEmails.length,
        });
        return { success: true, sentCount: subscriberEmails.length, messageId: info.messageId };
    }
    catch (error) {
        console.error('Error sending briefing emails:', error);
        throw error;
    }
}
async function sendErrorNotification(errorInfo) {
    try {
        const config = await getEmailConfig();
        if (!config.auth.user || !config.auth.pass)
            return;
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
    }
    catch {
        // non-critical
    }
}
//# sourceMappingURL=emailService.js.map