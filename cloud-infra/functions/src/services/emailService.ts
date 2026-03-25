import * as nodemailer from 'nodemailer';
import * as admin from 'firebase-admin';
import { retryWithBackoff } from '../utils/errorHandling';
import { buildOutputAssetBundle, generateEmailHtml, resolveOutputDate } from './reportAssetService';

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
    const pass = smtp.pass || config.auth.pass;
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
    const html = await generateEmailHtml(assetBundle.output, assetBundle.articles);

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
      console.log('No active subscribers found.');
      return { success: true, sentCount: 0, message: 'No subscribers configured' };
    }

    const info = await retryWithBackoff(() => transporter.sendMail({
      from,
      bcc: subscriberEmails,
      subject: `${options?.subjectPrefix || '[EUM PE]'} ${output.title || 'AI News Report'} (${resolveOutputDate(output)})`,
      html,
      attachments: [
        {
          filename: assetBundle.pdfFilename,
          content: assetBundle.pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
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
