import axios from 'axios';
import * as admin from 'firebase-admin';

async function getTelegramConfig() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  };
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────
// BUG-03 FIX: outputs 구조 기반으로 재작성
// ─────────────────────────────────────────
function resolveOutputDate(output: any): string {
  try {
    if (output.createdAt?.toDate) return output.createdAt.toDate().toLocaleDateString('ko-KR');
    if (output.createdAt?.seconds) return new Date(output.createdAt.seconds * 1000).toLocaleDateString('ko-KR');
    if (output.createdAt) return new Date(output.createdAt).toLocaleDateString('ko-KR');
  } catch { /* ignore */ }
  return new Date().toLocaleDateString('ko-KR');
}

export function formatOutputForTelegram(output: any, articles: any[]): string {
  const dateStr = resolveOutputDate(output);
  const structured = output.structuredOutput || {};
  const highlights: any[] = structured.highlights || [];
  const themes: any[] = structured.themes || [];
  const summary: string = structured.summary || '';

  let message = `📣 <b>[EUM PE] AI News Report</b> (${dateStr})\n`;
  message += `📋 ${escapeHtml(output.title || 'Analysis Report')} · Articles: ${output.articleCount || articles.length}\n\n`;

  // Executive Summary
  if (summary) {
    message += `💡 <b>Executive Summary</b>\n`;
    message += `${escapeHtml(summary.substring(0, 400))}\n\n`;
  }

  // Highlights
  if (highlights.length > 0) {
    message += `🎯 <b>Highlights</b>\n`;
    highlights.slice(0, 3).forEach((h: any) => {
      message += `• <b>${escapeHtml(h.title || '')}</b>\n`;
      if (h.description) message += `  └ ${escapeHtml(h.description.substring(0, 120))}\n`;
    });
    message += '\n';
  }

  // Key Themes
  if (themes.length > 0) {
    message += `🔍 <b>Key Themes</b>\n`;
    themes.slice(0, 3).forEach((t: any) => {
      message += `• <b>${escapeHtml(t.name || '')}</b>: ${escapeHtml((t.description || '').substring(0, 100))}\n`;
    });
    message += '\n';
  }

  // Articles by category
  if (articles.length > 0) {
    message += `📰 <b>Articles by Sector</b>\n`;
    const categories = [...new Set(articles.map((a: any) => a.category || '기타'))];
    categories.forEach(cat => {
      const catArticles = articles.filter((a: any) => (a.category || '기타') === cat).slice(0, 3);
      if (catArticles.length > 0) {
        message += `\n[${escapeHtml(String(cat))}]\n`;
        catArticles.forEach((a: any) => {
          const amountStr = a.deal?.amount && a.deal.amount !== 'undisclosed' ? ` (💰 ${escapeHtml(a.deal.amount)})` : '';
          message += `• <a href="${a.url || '#'}">${escapeHtml(a.title || '')}</a>${amountStr}\n`;
        });
      }
    });
  }

  return message;
}

export async function sendTelegramMessage(text: string, parseMode: 'HTML' | 'MarkdownV2' = 'HTML') {
  const config = await getTelegramConfig();

  if (!config.botToken || !config.chatId) {
    console.warn('Telegram Bot Token or Chat ID is not configured.');
    return { success: false, error: 'Telegram configuration missing' };
  }

  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  try {
    const response = await axios.post(url, {
      chat_id: config.chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: false,
    });
    return { success: true, messageId: response.data.result.message_id };
  } catch (error: any) {
    console.error('Error sending Telegram message:', error.response?.data || error.message);
    throw error;
  }
}

export async function sendErrorNotificationToAdmin(errorType: string, errorMessage: string, sourceName?: string) {
  const config = await getTelegramConfig();

  if (!config.botToken || !config.chatId) {
    return { success: false, error: 'Telegram configuration missing' };
  }

  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID || config.chatId;
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  const text = `🚨 <b>[EUM System Error]</b>\n\n` +
    `<b>Type:</b> ${escapeHtml(errorType)}\n` +
    (sourceName ? `<b>Source:</b> ${escapeHtml(sourceName)}\n` : '') +
    `<b>Time:</b> ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}\n\n` +
    `<b>Detail:</b>\n<pre>${escapeHtml(errorMessage)}</pre>`;

  try {
    const response = await axios.post(url, {
      chat_id: adminChatId,
      text,
      parse_mode: 'HTML',
    });
    return { success: true, messageId: response.data.result.message_id };
  } catch (error: any) {
    console.error('Error sending admin notification:', error.response?.data || error.message);
    return { success: false };
  }
}

async function loadTelegramArticles(output: any): Promise<any[]> {
  const db = admin.firestore();
  // Use orderedArticleIds (correct AI prompt order) if available, fallback to articleIds, then publishedInOutputId query
  const effectiveIds: string[] | undefined =
    (Array.isArray(output.orderedArticleIds) && output.orderedArticleIds.length > 0)
      ? output.orderedArticleIds
      : (Array.isArray(output.articleIds) && output.articleIds.length > 0)
        ? output.articleIds
        : undefined;

  if (effectiveIds) {
    const docs = await Promise.all(effectiveIds.map((id: string) => db.collection('articles').doc(id).get()));
    return docs.filter((d) => d.exists).map((d) => ({ id: d.id, ...(d.data() as any) }));
  }

  const snap = await db.collection('articles').where('publishedInOutputId', '==', output.id || '').get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
}

export function formatCustomReportForTelegram(output: any, articles: any[]): string {
  const dateStr = resolveOutputDate(output);
  const shareUrl = output.shareUrl as string | undefined;

  let message = `📣 <b>[EUM PE] 커스텀 리포트</b> (${dateStr})\n`;
  message += `📋 ${escapeHtml(output.title || 'Custom Report')} · 기사 ${articles.length}건\n\n`;

  if (shareUrl) {
    message += `🔗 <a href="${shareUrl}">웹에서 보기</a>\n\n`;
  }

  if (articles.length > 0) {
    message += `📰 <b>포함 기사</b>\n`;
    articles.slice(0, 10).forEach((a: any, idx: number) => {
      const title = escapeHtml(a.title || '제목 없음');
      const source = a.source ? ` (${escapeHtml(a.source)})` : '';
      if (a.url) {
        message += `${idx + 1}. <a href="${a.url}">${title}</a>${source}\n`;
      } else {
        message += `${idx + 1}. ${title}${source}\n`;
      }
    });
    if (articles.length > 10) {
      message += `  … 외 ${articles.length - 10}건\n`;
    }
  }

  return message;
}

export async function sendBriefingToTelegram(outputId: string) {
  const db = admin.firestore();

  try {
    // BUG-03 FIX: outputs 컬렉션 사용
    const outputDoc = await db.collection('outputs').doc(outputId).get();
    if (!outputDoc.exists) {
      throw new Error(`Output ${outputId} not found`);
    }
    const output: any = { id: outputDoc.id, ...outputDoc.data()! };

    const articles = await loadTelegramArticles(output);

    const message = output.type === 'custom_report'
      ? formatCustomReportForTelegram(output, articles)
      : formatOutputForTelegram(output, articles);

    // Telegram has 4096 char limit per message
    const chunks: string[] = [];
    if (message.length <= 4096) {
      chunks.push(message);
    } else {
      let remaining = message;
      while (remaining.length > 0) {
        chunks.push(remaining.substring(0, 4000));
        remaining = remaining.substring(4000);
      }
    }

    let lastResult: any = null;
    for (const chunk of chunks) {
      lastResult = await sendTelegramMessage(chunk, 'HTML');
    }

    if (lastResult?.success) {
      await outputDoc.ref.update({
        telegramSent: true,
        telegramSentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return lastResult;
  } catch (error) {
    console.error('Error in sendBriefingToTelegram:', error);
    throw error;
  }
}

export async function sendTrackedCompanyTelegramAlert(article: {
  title?: string;
  source?: string;
  url?: string;
  keywordMatched?: string | null;
  collectedAt?: any;
}) {
  const trackedCompany = `${article.keywordMatched || ''}`.trim();
  if (!trackedCompany) {
    return { success: false, error: 'Tracked company missing' };
  }

  const collectedAt = article.collectedAt?.toDate
    ? article.collectedAt.toDate()
    : article.collectedAt
      ? new Date(article.collectedAt)
      : new Date();

  const text =
    `🔔 <b>[EUM PE] 추적회사 기사 감지</b>\n\n` +
    `<b>회사:</b> ${escapeHtml(trackedCompany)}\n` +
    `<b>매체:</b> ${escapeHtml(article.source || '-')}\n` +
    `<b>시각:</b> ${escapeHtml(collectedAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))}\n\n` +
    `<b>제목:</b>\n${escapeHtml(article.title || '')}\n\n` +
    (article.url ? `<a href="${article.url}">기사 열기</a>` : '');

  return sendTelegramMessage(text, 'HTML');
}
