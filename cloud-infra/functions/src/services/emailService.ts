import * as logger from 'firebase-functions/logger';
import * as nodemailer from 'nodemailer';
import * as admin from 'firebase-admin';
import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { retryWithBackoff } from '../utils/errorHandling';
import { buildOutputAssetBundle, buildEmailHtml, resolveOutputDate } from './reportAssetService';

// ---------------------------------------------------------------------------
// SMTP password encryption (AES-256-GCM)
// Requires SMTP_ENCRYPT_KEY env var (min 32 chars). If absent, pass is stored
// as plain text (backward-compatible) and decryption is a no-op.
// ---------------------------------------------------------------------------

export function encryptSmtpPass(plain: string): string {
  const key = process.env.SMTP_ENCRYPT_KEY;
  if (!key || key.length < 32) return plain;
  const keyBuf = Buffer.from(key.slice(0, 32), 'utf8');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSmtpPass(stored: string): string {
  if (!stored || !stored.startsWith('enc:')) return stored;
  const key = process.env.SMTP_ENCRYPT_KEY;
  if (!key || key.length < 32) {
    logger.warn('[SMTP] SMTP_ENCRYPT_KEY not set but encrypted password found in Firestore');
    return stored;
  }
  try {
    const parts = stored.split(':');
    if (parts.length !== 4) return stored;
    const [, ivB64, tagB64, encB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const enc = Buffer.from(encB64, 'base64');
    const keyBuf = Buffer.from(key.slice(0, 32), 'utf8');
    const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString('utf8') + decipher.final('utf8');
  } catch (err) {
    logger.error('[SMTP] Failed to decrypt SMTP password:', err);
    return stored;
  }
}

/** Generate a per-email HMAC token for unsubscribe link verification */
export function generateUnsubscribeToken(email: string, companyId: string): string {
  const secret = process.env.EMAIL_HMAC_SECRET || process.env.SMTP_PASS || 'eum-unsub-secret';
  return createHmac('sha256', secret).update(`${email}:${companyId}`).digest('hex');
}

/** Verify an unsubscribe token */
export function verifyUnsubscribeToken(email: string, companyId: string, token: string): boolean {
  return generateUnsubscribeToken(email, companyId) === token;
}

const FUNCTIONS_BASE_URL = 'https://us-central1-eumnews-9a99c.cloudfunctions.net';

function buildUnsubscribeUrl(email: string, companyId: string): string {
  const token = generateUnsubscribeToken(email, companyId);
  return `${FUNCTIONS_BASE_URL}/handleUnsubscribe?email=${encodeURIComponent(email)}&companyId=${encodeURIComponent(companyId)}&token=${token}`;
}

async function getEmailConfig(companyId?: string | null) {
  let companySmtp: any = null;
  if (companyId) {
    try {
      const settingsDoc = await admin.firestore().collection('companySettings').doc(companyId).get();
      companySmtp = (settingsDoc.data() as any)?.smtp || null;
    } catch {
      companySmtp = null;
    }
  }

  return {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    from: process.env.SMTP_FROM || '"EUM Private Equity" <noreply@eumpe.com>',
    companySmtp,
  };
}

/** Test SMTP connection and send a test email to the configured user address */
export async function testSmtpConfig(smtpConfig: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}): Promise<{ success: boolean; message: string }> {
  const { host, port, secure, user, pass: rawPass, from } = smtpConfig;
  if (!user || !rawPass) {
    return { success: false, message: 'SMTP 사용자와 비밀번호를 입력해 주세요.' };
  }
  const pass = decryptSmtpPass(rawPass);
  const transporter = nodemailer.createTransport({
    host: host || 'smtp.gmail.com',
    port: port || 587,
    secure: secure || false,
    auth: { user, pass },
  });
  try {
    await transporter.verify();
    await transporter.sendMail({
      from: from || user,
      to: user,
      subject: '[EUM] SMTP 연결 테스트',
      html: '<div style="font-family:sans-serif;max-width:480px;padding:24px"><h3 style="color:#1e3a5f">EUM News — SMTP 연결 테스트</h3><p>이 메일이 수신되면 SMTP 설정이 정상적으로 작동하고 있습니다.</p></div>',
    });
    return { success: true, message: `연결 성공. 테스트 메일을 ${user}로 발송했습니다.` };
  } catch (err: any) {
    return { success: false, message: err.message || '연결 실패' };
  }
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
    const outputDoc = await db.collection('outputs').doc(outputId).get();
    if (!outputDoc.exists) {
      throw new Error(`Output ${outputId} not found`);
    }
    const output = outputDoc.data()!;
    const companyId = output.companyId;

    const config = await getEmailConfig(companyId);
    const smtp = config.companySmtp || {};
    const host = smtp.host || config.host;
    const port = Number(smtp.port || config.port);
    const secure = typeof smtp.secure === 'boolean' ? smtp.secure : config.secure;
    const user = smtp.user || config.auth.user;
    const rawPass = smtp.pass || config.auth.pass;
    const pass = rawPass ? decryptSmtpPass(rawPass) : undefined;
    const from = smtp.from || config.from;

    if (!user || !pass) {
      throw new Error('SMTP credentials not configured');
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
    const assetBundle = await buildOutputAssetBundle(outputId);

    let subscriberEmails: string[] = [];

    if (companyId) {
      const settingsDoc = await db.collection('companySettings').doc(companyId).get();
      const settingsData = settingsDoc.data() as any;
      subscriberEmails = settingsData?.subscriberEmails || [];
    }

    if (subscriberEmails.length === 0) {
      const subscribersSnapshot = await db.collection('subscribers').where('active', '==', true).get();
      subscriberEmails = subscribersSnapshot.docs.map((doc) => doc.data().email).filter(Boolean);
    }

    if (Array.isArray(explicitRecipients) && explicitRecipients.length > 0) {
      subscriberEmails = explicitRecipients.filter(Boolean);
    }

    if (subscriberEmails.length === 0) {
      logger.info('No active subscribers found.');
      return { success: true, sentCount: 0, failedCount: 0, failedEmails: [], message: 'No subscribers configured' };
    }

    // Filter out unsubscribed emails
    if (companyId) {
      try {
        const unsubSnap = await db.collection('emailUnsubscribes').doc(companyId).collection('entries').get();
        const unsubEmails = new Set(unsubSnap.docs.map((d) => (d.data().email || '').toLowerCase()));
        subscriberEmails = subscriberEmails.filter((e) => !unsubEmails.has(e.toLowerCase()));
      } catch {
        // If collection doesn't exist yet, continue with all subscribers
      }
    }

    if (subscriberEmails.length === 0) {
      logger.info('All subscribers have unsubscribed.');
      return { success: true, sentCount: 0, failedCount: 0, failedEmails: [], message: 'All subscribers unsubscribed' };
    }

    const shareUrl = assetBundle.output.shareUrl as string | undefined;
    const subject = `${options?.subjectPrefix || '[EUM PE]'} ${output.title || 'AI News Report'} (${resolveOutputDate(output)})`;

    // Send individually to embed per-recipient unsubscribe links
    let sentCount = 0;
    const failedEmails: string[] = [];
    let lastMessageId: string | undefined;

    for (const recipientEmail of subscriberEmails) {
      const unsubscribeUrl = companyId ? buildUnsubscribeUrl(recipientEmail, companyId) : undefined;
      const html = await buildEmailHtml(assetBundle.output, assetBundle.articles, { shareUrl, unsubscribeUrl });
      try {
        const info = await retryWithBackoff(() => transporter.sendMail({
          from,
          to: recipientEmail,
          subject,
          html,
          attachments: [
            {
              filename: assetBundle.pdfFilename,
              content: assetBundle.pdfBuffer,
              contentType: 'application/pdf',
            },
          ],
        }));
        lastMessageId = info.messageId;
        sentCount++;
      } catch (err) {
        logger.error(`Failed to send email to ${recipientEmail}:`, err);
        failedEmails.push(recipientEmail);
      }
    }

    const markField = options?.markAsField || 'emailSentAt';
    await outputDoc.ref.set({
      emailSent: true,
      emailSuccessCount: sentCount,
      emailFailedCount: failedEmails.length,
      emailSendLog: {
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        sentCount,
        failedCount: failedEmails.length,
        failedEmails,
      },
      [markField]: admin.firestore.FieldValue.serverTimestamp(),
      ...(options?.metadata || {}),
    }, { merge: true });

    logger.info(`[sendOutputEmails] outputId=${outputId} sent=${sentCount} failed=${failedEmails.length}`);
    return { success: true, sentCount, failedCount: failedEmails.length, failedEmails, messageId: lastMessageId };
  } catch (error) {
    logger.error('Error sending briefing emails:', error);
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
    const severityEmoji = errorInfo.severity === 'critical' ? '🚨' : errorInfo.severity === 'high' ? '⚠️' : 'ℹ️';

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
