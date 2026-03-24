import * as iconv from 'iconv-lite';
import * as cheerio from 'cheerio';

export function detectEncodingFromHtml(buffer: Buffer): string {
  const html = buffer.toString('utf8');
  const $ = cheerio.load(html);

  let charset = $('meta[charset]').attr('charset') || '';
  if (!charset) {
    const contentType = $('meta[http-equiv="Content-Type"]').attr('content') || '';
    const match = contentType.match(/charset=([\w-]+)/i);
    if (match) charset = match[1];
  }

  return (charset || 'utf-8').toLowerCase();
}

export function detectEncodingFromContentType(contentType: string): string {
  if (!contentType) return '';
  const match = contentType.match(/charset=([\w-]+)/i);
  return match ? match[1].toLowerCase() : '';
}

export function decodeBuffer(buffer: Buffer, encoding?: string, contentTypeHeader?: string): string {
  let enc = encoding;
  if (!enc && contentTypeHeader) {
    enc = detectEncodingFromContentType(contentTypeHeader);
  }
  if (!enc) {
    enc = detectEncodingFromHtml(buffer);
  }

  const isEucKr = ['euc-kr', 'ksc5601', 'cp949', 'ks_c_5601-1987'].includes((enc || '').toLowerCase());

  try {
    if (isEucKr) {
      const decoded = iconv.decode(buffer, 'euc-kr');
      const mojibakeCount = (decoded.match(/[\uFFFD\u0080-\u009F]/g) || []).length;
      if (mojibakeCount < decoded.length * 0.1) {
        return decoded;
      }
      return iconv.decode(buffer, 'utf-8');
    }
    return iconv.decode(buffer, 'utf-8');
  } catch (error) {
    console.error('Decoding failed:', error);
    return buffer.toString('utf-8');
  }
}

export function cleanHtmlContent(html: string): string {
  if (!html) return '';

  let cleaned = html;

  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  const noisyPatterns = [
    /기사\s*공유/gi,
    /공유하기/gi,
    /글자\s*크기/gi,
    /북마크/gi,
    /스크랩/gi,
    /프린트/gi,
    /좋아요/gi,
    /댓글/gi,
    /채널\s*구독/gi,
    /카카오톡/gi,
    /페이스북/gi,
    /주소\s*복사/gi,
  ];
  noisyPatterns.forEach((pattern) => {
    cleaned = cleaned.replace(pattern, ' ');
  });

  cleaned = cleaned
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, (match) => {
      try {
        const code = parseInt(match.substring(2, match.length - 1), 10);
        return String.fromCharCode(code);
      } catch {
        return match;
      }
    })
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned;
}

export function fixEncodingIssues(text: string): string {
  if (!text) return '';

  const suspiciousCharCount = (text.match(/\uFFFD/g) || []).length;
  const hasBrokenHangul = /[가-힣]\uFFFD|\uFFFD[가-힣]|[A-Za-z]\uFFFD|\uFFFD[A-Za-z]/.test(text);
  if (!suspiciousCharCount && !hasBrokenHangul) {
    return text;
  }

  const attempts = [
    () => iconv.decode(Buffer.from(text, 'latin1'), 'euc-kr'),
    () => iconv.decode(Buffer.from(text, 'binary'), 'utf-8'),
  ];

  for (const attempt of attempts) {
    try {
      const recovered = attempt();
      const recoveredSuspicious = (recovered.match(/\uFFFD/g) || []).length;
      if (recovered && recoveredSuspicious < suspiciousCharCount) {
        return recovered;
      }
    } catch {
      // ignore failed recovery attempts
    }
  }

  return text;
}
