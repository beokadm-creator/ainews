import * as logger from 'firebase-functions/logger';
import axios from 'axios';
import * as admin from 'firebase-admin';

async function getTelegramConfig() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  };
}

export interface TelegramGroupConfig {
  chatId: string;
  botToken?: string; // 없으면 env var 사용
}

async function resolveToken(groupConfig?: TelegramGroupConfig): Promise<string | undefined> {
  return groupConfig?.botToken || process.env.TELEGRAM_BOT_TOKEN;
}

export async function sendMessageToGroup(
  text: string,
  groupConfig: TelegramGroupConfig,
  parseMode: 'HTML' | 'MarkdownV2' = 'HTML',
  maxRetries = 3,
) {
  const token = await resolveToken(groupConfig);
  if (!token || !groupConfig.chatId) {
    return { success: false, error: 'Telegram group config missing' };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(url, {
        chat_id: groupConfig.chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: false,
      });
      return { success: true, messageId: response.data.result.message_id };
    } catch (error: any) {
      const status = error.response?.status;
      if (status === 429) {
        const delay = parseInt(error.response?.headers?.['retry-after'] || '0') * 1000 || (2 ** attempt) * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (status === 400 && parseMode === 'HTML') {
        const plain = htmlToPlaintext(text);
        return await axios.post(url, {
          chat_id: groupConfig.chatId,
          text: plain.substring(0, 4096),
          disable_web_page_preview: false,
        }).then(r => ({ success: true, messageId: r.data.result.message_id }))
          .catch(() => ({ success: false, error: 'HTML parse failed and plaintext fallback also failed' }));
      }
      if (attempt === maxRetries) {
        logger.error('Error sending to Telegram group:', error.response?.data || error.message);
        return { success: false, error: error.message };
      }
      await new Promise(r => setTimeout(r, (2 ** attempt) * 1000));
    }
  }
  return { success: false, error: 'Max retries exceeded' };
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// HTML → plaintext 변환 시 <a href> 링크를 "텍스트 (URL)" 형태로 보존
function htmlToPlaintext(html: string): string {
  return html
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, label) => {
      const cleanLabel = label.replace(/<[^>]*>/g, '').trim();
      return cleanLabel ? `${cleanLabel} (${url})` : url;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

export function splitMessageSafely(message: string, maxLen = 3800): string[] {
  if (message.length <= maxLen) return [message];

  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // 안전한 분할점 찾기: 개행 → 닫는 태그 → 공백 순서
    let splitAt = -1;
    const searchRange = remaining.substring(maxLen - 200, maxLen + 200);

    // 1순위: 개행 문자
    splitAt = remaining.lastIndexOf('\n', maxLen);
    // 2순위: 닫는 HTML 태그 뒤
    if (splitAt < maxLen - 500) {
      const tagClose = remaining.lastIndexOf('>', maxLen);
      if (tagClose > maxLen - 500) splitAt = tagClose + 1;
    }
    // 3순위: 공백
    if (splitAt < maxLen - 500) {
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }

    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }

  return chunks;
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

export async function sendTelegramMessage(text: string, parseMode: 'HTML' | 'MarkdownV2' = 'HTML', maxRetries = 3) {
  const config = await getTelegramConfig();

  if (!config.botToken || !config.chatId) {
    logger.warn('Telegram Bot Token or Chat ID is not configured.');
    return { success: false, error: 'Telegram configuration missing' };
  }

  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(url, {
        chat_id: config.chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: false,
      });
      return { success: true, messageId: response.data.result.message_id };
    } catch (error: any) {
      const status = error.response?.status;

      if (status === 429) {
        // Retry-After 헤더 활용
        const retryAfter = error.response?.headers?.['retry-after'];
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : (2 ** attempt) * 1000;
        logger.warn(`Telegram rate limited, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (status === 400 && parseMode === 'HTML') {
        logger.warn('Telegram HTML parse failed, retrying as plain text');
        const plain = htmlToPlaintext(text);
        return await axios.post(url, {
          chat_id: config.chatId,
          text: plain.substring(0, 4096),
          disable_web_page_preview: false,
        }).then(r => ({ success: true, messageId: r.data.result.message_id }));
      }

      if (attempt === maxRetries) {
        logger.error('Error sending Telegram message:', error.response?.data || error.message);
        throw error;
      }
      await new Promise(r => setTimeout(r, (2 ** attempt) * 1000));
    }
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
    logger.error('Error sending admin notification:', error.response?.data || error.message);
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
    const results: any[] = [];
    for (let i = 0; i < effectiveIds.length; i += 10) {
      const chunk = effectiveIds.slice(i, i + 10);
      const snap = await db.collection('articles')
        .where(admin.firestore.FieldPath.documentId(), 'in', chunk)
        .get();
      results.push(...snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }
    // 원래 배열 순서 보존
    const byId = new Map(results.map(a => [a.id, a]));
    return effectiveIds.map((id: string) => byId.get(id)).filter(Boolean);
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

export async function sendBriefingToTelegram(outputId: string, groups?: TelegramGroupConfig[]) {
  const db = admin.firestore();

  try {
    const outputDoc = await db.collection('outputs').doc(outputId).get();
    if (!outputDoc.exists) {
      throw new Error(`Output ${outputId} not found`);
    }
    const output: any = { id: outputDoc.id, ...outputDoc.data()! };

    const articles = await loadTelegramArticles(output);

    const message = output.type === 'custom_report'
      ? formatCustomReportForTelegram(output, articles)
      : formatOutputForTelegram(output, articles);

    const chunks: string[] = splitMessageSafely(message);

    let lastResult: any = null;

    if (groups && groups.length > 0) {
      // 등록된 그룹 전체에 발송
      for (const chunk of chunks) {
        const results = await Promise.allSettled(
          groups.map(g => sendMessageToGroup(chunk, g, 'HTML'))
        );
        const succeeded = results.filter(r => r.status === 'fulfilled' && (r as any).value?.success);
        lastResult = { success: succeeded.length > 0, sentCount: succeeded.length, totalCount: groups.length };
      }
    } else {
      // env var 기본값으로 발송
      for (const chunk of chunks) {
        lastResult = await sendTelegramMessage(chunk, 'HTML');
      }
    }

    if (lastResult?.success) {
      await outputDoc.ref.update({
        telegramSent: true,
        telegramSentAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    return lastResult;
  } catch (error) {
    logger.error('Error in sendBriefingToTelegram:', error);
    throw error;
  }
}

export async function sendTrackedCompanyTelegramAlert(
  article: {
    title?: string;
    source?: string;
    url?: string;
    keywordMatched?: string | null;
    collectedAt?: any;
    summary?: string[];
    content?: string;
  },
  groups?: TelegramGroupConfig[],
) {
  const trackedCompany = `${article.keywordMatched || ''}`.trim();
  if (!trackedCompany) {
    return { success: false, error: 'Tracked company missing' };
  }

  const collectedAt = article.collectedAt?.toDate
    ? article.collectedAt.toDate()
    : article.collectedAt
      ? new Date(article.collectedAt)
      : new Date();

  // 요약문 조합: summary 배열 우선, 없으면 content 앞부분
  let summaryText = '';
  if (Array.isArray(article.summary) && article.summary.length > 0) {
    summaryText = article.summary.map((s) => `${s || ''}`.trim()).filter(Boolean).join('\n');
  } else if (article.content) {
    summaryText = `${article.content}`.trim().substring(0, 500);
    if (article.content.length > 500) summaryText += '…';
  }

  const text =
    `🔔 <b>[EUM PE] 추적회사 기사 감지</b>\n\n` +
    `<b>회사:</b> ${escapeHtml(trackedCompany)}\n` +
    `<b>매체:</b> ${escapeHtml(article.source || '-')}\n` +
    `<b>시각:</b> ${escapeHtml(collectedAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }))}\n\n` +
    `<b>제목:</b>\n${escapeHtml(article.title || '')}\n` +
    (summaryText ? `\n<b>요약:</b>\n${escapeHtml(summaryText)}\n` : '') +
    (article.url ? `\n<a href="${article.url}">원문 보기</a>` : '');

  // 설정된 그룹이 있으면 각 그룹에 발송, 없으면 env var 기본값 사용
  if (groups && groups.length > 0) {
    const results = await Promise.allSettled(
      groups.map(g => sendMessageToGroup(text, g, 'HTML'))
    );
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value?.success));
    return { success: failed.length === 0, sentCount: groups.length - failed.length };
  }

  return sendTelegramMessage(text, 'HTML');
}
