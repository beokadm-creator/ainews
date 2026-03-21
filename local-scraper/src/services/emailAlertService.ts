import nodemailer from 'nodemailer';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('[EmailAlert] SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env');
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });

  return transporter;
}

export async function sendScraperErrorAlert(
  source: string,
  errorMessage: string,
  context?: { found?: number; collected?: number; durationMs?: number }
): Promise<void> {
  const tp = getTransporter();
  if (!tp) return;

  const to = process.env.SMTP_ALERT_TO || process.env.SMTP_USER;
  const from = process.env.SMTP_USER;
  const kstTime = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  try {
    await tp.sendMail({
      from: `"EUM NEWS 스크래퍼" <${from}>`,
      to,
      subject: `[EUM NEWS 알림] ${source} 수집 오류 — ${kstTime}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <h2 style="color:#dc2626;margin-top:0">⚠️ 스크래퍼 오류 발생</h2>
          <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
            <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;width:120px">소스</td>
                <td style="padding:8px;border-bottom:1px solid #eee">${source}</td></tr>
            <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">발생 시각</td>
                <td style="padding:8px;border-bottom:1px solid #eee">${kstTime}</td></tr>
            <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">오류 내용</td>
                <td style="padding:8px;border-bottom:1px solid #eee;color:#dc2626">${errorMessage}</td></tr>
            ${context?.found != null ? `<tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">수집 현황</td>
                <td style="padding:8px;border-bottom:1px solid #eee">발견 ${context.found}건 / 저장 ${context.collected ?? 0}건</td></tr>` : ''}
          </table>
          <p style="color:#666;font-size:13px">EUM NEWS 로컬 스크래퍼에서 자동 발송된 알림입니다.</p>
        </div>
      `,
    });
    console.log(`[EmailAlert] Sent error alert for ${source}`);
  } catch (e: any) {
    console.warn('[EmailAlert] Failed to send email:', e.message);
  }
}

export async function sendScraperStaleAlert(
  source: string,
  lastRunAt: Date,
  thresholdHours: number
): Promise<void> {
  const tp = getTransporter();
  if (!tp) return;

  const to = process.env.SMTP_ALERT_TO || process.env.SMTP_USER;
  const from = process.env.SMTP_USER;
  const kstTime = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const lastRunKst = lastRunAt.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  try {
    await tp.sendMail({
      from: `"EUM NEWS 스크래퍼" <${from}>`,
      to,
      subject: `[EUM NEWS 알림] ${source} 수집 중단 감지 — ${kstTime}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
          <h2 style="color:#d97706;margin-top:0">⏰ 스크래퍼 수집 중단 감지</h2>
          <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
            <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold;width:120px">소스</td>
                <td style="padding:8px;border-bottom:1px solid #eee">${source}</td></tr>
            <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">현재 시각</td>
                <td style="padding:8px;border-bottom:1px solid #eee">${kstTime}</td></tr>
            <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">마지막 수집</td>
                <td style="padding:8px;border-bottom:1px solid #eee">${lastRunKst}</td></tr>
            <tr><td style="padding:8px;background:#f9f9f9;font-weight:bold">경과 시간</td>
                <td style="padding:8px;border-bottom:1px solid #eee;color:#d97706">${thresholdHours}시간 이상 미수집</td></tr>
          </table>
          <p style="color:#666;font-size:13px">PC가 꺼져 있거나 스크래퍼 서버가 중단된 것 같습니다.</p>
          <p style="color:#666;font-size:13px">EUM NEWS 로컬 스크래퍼에서 자동 발송된 알림입니다.</p>
        </div>
      `,
    });
    console.log(`[EmailAlert] Sent stale alert for ${source}`);
  } catch (e: any) {
    console.warn('[EmailAlert] Failed to send email:', e.message);
  }
}
