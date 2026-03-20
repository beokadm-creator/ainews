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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatOutputForTelegram = formatOutputForTelegram;
exports.sendTelegramMessage = sendTelegramMessage;
exports.sendErrorNotificationToAdmin = sendErrorNotificationToAdmin;
exports.sendBriefingToTelegram = sendBriefingToTelegram;
const axios_1 = __importDefault(require("axios"));
const admin = __importStar(require("firebase-admin"));
async function getTelegramConfig() {
    return {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
    };
}
function escapeHtml(text) {
    if (!text)
        return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
// ─────────────────────────────────────────
// BUG-03 FIX: outputs 구조 기반으로 재작성
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
function formatOutputForTelegram(output, articles) {
    const dateStr = resolveOutputDate(output);
    const structured = output.structuredOutput || {};
    const highlights = structured.highlights || [];
    const themes = structured.themes || [];
    const summary = structured.summary || '';
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
        highlights.slice(0, 3).forEach((h) => {
            message += `• <b>${escapeHtml(h.title || '')}</b>\n`;
            if (h.description)
                message += `  └ ${escapeHtml(h.description.substring(0, 120))}\n`;
        });
        message += '\n';
    }
    // Key Themes
    if (themes.length > 0) {
        message += `🔍 <b>Key Themes</b>\n`;
        themes.slice(0, 3).forEach((t) => {
            message += `• <b>${escapeHtml(t.name || '')}</b>: ${escapeHtml((t.description || '').substring(0, 100))}\n`;
        });
        message += '\n';
    }
    // Articles by category
    if (articles.length > 0) {
        message += `📰 <b>Articles by Sector</b>\n`;
        const categories = [...new Set(articles.map((a) => a.category || '기타'))];
        categories.forEach(cat => {
            const catArticles = articles.filter((a) => (a.category || '기타') === cat).slice(0, 3);
            if (catArticles.length > 0) {
                message += `\n[${escapeHtml(String(cat))}]\n`;
                catArticles.forEach((a) => {
                    const amountStr = a.deal?.amount && a.deal.amount !== 'undisclosed' ? ` (💰 ${escapeHtml(a.deal.amount)})` : '';
                    message += `• <a href="${a.url || '#'}">${escapeHtml(a.title || '')}</a>${amountStr}\n`;
                });
            }
        });
    }
    return message;
}
async function sendTelegramMessage(text, parseMode = 'HTML') {
    const config = await getTelegramConfig();
    if (!config.botToken || !config.chatId) {
        console.warn('Telegram Bot Token or Chat ID is not configured.');
        return { success: false, error: 'Telegram configuration missing' };
    }
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    try {
        const response = await axios_1.default.post(url, {
            chat_id: config.chatId,
            text,
            parse_mode: parseMode,
            disable_web_page_preview: false,
        });
        return { success: true, messageId: response.data.result.message_id };
    }
    catch (error) {
        console.error('Error sending Telegram message:', error.response?.data || error.message);
        throw error;
    }
}
async function sendErrorNotificationToAdmin(errorType, errorMessage, sourceName) {
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
        const response = await axios_1.default.post(url, {
            chat_id: adminChatId,
            text,
            parse_mode: 'HTML',
        });
        return { success: true, messageId: response.data.result.message_id };
    }
    catch (error) {
        console.error('Error sending admin notification:', error.response?.data || error.message);
        return { success: false };
    }
}
async function sendBriefingToTelegram(outputId) {
    const db = admin.firestore();
    try {
        // BUG-03 FIX: outputs 컬렉션 사용
        const outputDoc = await db.collection('outputs').doc(outputId).get();
        if (!outputDoc.exists) {
            throw new Error(`Output ${outputId} not found`);
        }
        const output = outputDoc.data();
        const articlesSnapshot = await db.collection('articles')
            .where('publishedInOutputId', '==', outputId)
            .get();
        const articles = articlesSnapshot.docs.map(doc => doc.data());
        const message = formatOutputForTelegram(output, articles);
        // Telegram has 4096 char limit per message
        const chunks = [];
        if (message.length <= 4096) {
            chunks.push(message);
        }
        else {
            let remaining = message;
            while (remaining.length > 0) {
                chunks.push(remaining.substring(0, 4000));
                remaining = remaining.substring(4000);
            }
        }
        let lastResult = null;
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
    }
    catch (error) {
        console.error('Error in sendBriefingToTelegram:', error);
        throw error;
    }
}
//# sourceMappingURL=telegramService.js.map