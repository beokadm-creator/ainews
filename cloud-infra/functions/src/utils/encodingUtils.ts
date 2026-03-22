import * as iconv from 'iconv-lite';
import * as cheerio from 'cheerio';

/**
 * Encoding utilities for handling text encoding issues
 */

/**
 * HTML 내 charset 메타 태그를 찾아 인코딩을 감지합니다.
 */
export function detectEncodingFromHtml(buffer: Buffer): string {
  const html = buffer.toString('utf8');
  const $ = cheerio.load(html);
  
  // <meta charset="euc-kr">
  let charset = $('meta[charset]').attr('charset') || '';
  
  // <meta http-equiv="Content-Type" content="text/html; charset=euc-kr">
  if (!charset) {
    const contentType = $('meta[http-equiv="Content-Type"]').attr('content') || '';
    const match = contentType.match(/charset=([\w-]+)/i);
    if (match) charset = match[1];
  }

  return (charset || 'utf-8').toLowerCase();
}

/**
 * HTTP Content-Type 헤더에서 charset을 추출합니다.
 * e.g. "text/html; charset=euc-kr" → "euc-kr"
 */
export function detectEncodingFromContentType(contentType: string): string {
  if (!contentType) return '';
  const match = contentType.match(/charset=([\w-]+)/i);
  return match ? match[1].toLowerCase() : '';
}

/**
 * 버퍼 데이터를 감지된 인코딩에 맞춰 문자열로 변환합니다.
 * @param buffer - 원시 바이트 버퍼
 * @param encoding - 명시적 인코딩 (선택), 없으면 Content-Type → HTML meta 순으로 감지
 * @param contentTypeHeader - axios 응답의 Content-Type 헤더 (선택)
 */
export function decodeBuffer(buffer: Buffer, encoding?: string, contentTypeHeader?: string): string {
  let enc = encoding;
  if (!enc && contentTypeHeader) {
    enc = detectEncodingFromContentType(contentTypeHeader);
  }
  if (!enc) {
    enc = detectEncodingFromHtml(buffer);
  }

  const isEucKr = enc === 'euc-kr' || enc === 'ksc5601' || enc === 'cp949' || enc === 'ks_c_5601-1987';

  try {
    if (isEucKr) {
      const decoded = iconv.decode(buffer, 'euc-kr');
      // Verify decoded content doesn't contain too many mojibake patterns
      const mojibakeCount = (decoded.match(/[\uFFFD\u0080-\u009F]/g) || []).length;
      if (mojibakeCount < decoded.length * 0.1) { // Less than 10% mojibake
        return decoded;
      }
      // Fallback if EUC-KR decode resulted in too much garbage
      console.warn('EUC-KR decode produced too much mojibake, trying UTF-8');
      return iconv.decode(buffer, 'utf-8');
    }
    return iconv.decode(buffer, 'utf-8');
  } catch (err) {
    console.error('Decoding failed:', err);
    return buffer.toString('utf-8');
  }
}

/**
 * Clean and normalize HTML content
 * Removes: script/style tags, HTML tags, UI elements (뉴스듣기, 글자크기, 기사공유, 구독, 북마크, 다크모드, 프린트 등)
 */
export function cleanHtmlContent(html: string): string {
  if (!html) return '';

  let cleaned = html;

  // Remove script and style tags
  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Remove common news UI elements text patterns (뉴스 듣기, 글자크기, 기사공유, 구독, 북마크, 다크모드, 프린트 등)
  // Korean news sites often embed these as text/comments
  cleaned = cleaned.replace(/뉴스\s*듣기/gi, '');
  cleaned = cleaned.replace(/글자\s*크기/gi, '');
  cleaned = cleaned.replace(/글자\s*크기\s*설정/gi, '');
  cleaned = cleaned.replace(/기사\s*공유/gi, '');
  cleaned = cleaned.replace(/기사공유/gi, '');
  cleaned = cleaned.replace(/페이스북/gi, '');
  cleaned = cleaned.replace(/트위터|엑스/gi, '');
  cleaned = cleaned.replace(/카카오톡/gi, '');
  cleaned = cleaned.replace(/이메일/gi, '');
  cleaned = cleaned.replace(/주소복사|주소\s*복사/gi, '');
  cleaned = cleaned.replace(/북마크/gi, '');
  cleaned = cleaned.replace(/다크모드/gi, '');
  cleaned = cleaned.replace(/프린트/gi, '');
  cleaned = cleaned.replace(/채널구독|채널\s*구독/gi, '');
  cleaned = cleaned.replace(/네이버\s*채널/gi, '');
  cleaned = cleaned.replace(/다음\s*채널/gi, '');

  // Remove common footer/boilerplate patterns (※'갭 월드'는... 같은 코너 설명 등)
  cleaned = cleaned.replace(/※.*?에서\s*확인하세요\./gi, '');
  cleaned = cleaned.replace(/코너와\s*기자페이지를.*?구독해주세요\./gi, '');
  cleaned = cleaned.replace(/궁금한\s*사항이.*?환영합니다\./gi, '');
  cleaned = cleaned.replace(/제\s*메일로\s*연락주시면.*?반영하겠습니다\./gi, '');
  cleaned = cleaned.replace(/\+구독\s*영상/gi, '');
  cleaned = cleaned.replace(/이\s*기사를\s*추천합니다/gi, '');
  cleaned = cleaned.replace(/좋아요.*?ⓒ/gi, 'ⓒ');

  // Remove HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');

  // HTML entities
  cleaned = cleaned.replace(/&nbsp;/g, ' ');
  cleaned = cleaned.replace(/&amp;/g, '&');
  cleaned = cleaned.replace(/&lt;/g, '<');
  cleaned = cleaned.replace(/&gt;/g, '>');
  cleaned = cleaned.replace(/&quot;/g, '"');
  cleaned = cleaned.replace(/&#39;/g, "'");
  cleaned = cleaned.replace(/&#\d+;/g, match => {
    try {
      const code = parseInt(match.substring(2, match.length - 1));
      return String.fromCharCode(code);
    } catch (e) {
      return match;
    }
  });

  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

/**
 * 이미 깨져서 넘어온 문자열(latin1 -> utf8 오해)을 복구 시도합니다.
 */
export function fixEncodingIssues(text: string): string {
  if (!text) return '';
  
  // 간단한 휴리스틱: 특수문자가 너무 많거나 깨진 패턴 감지
  const hasIssues = /[À-ÿ]/.test(text) || text.includes('');
  if (!hasIssues) return text;

  try {
    // latin1 버퍼로 되돌린 후 euc-kr로 다시 읽기 시도
    const buf = Buffer.from(text, 'latin1');
    return iconv.decode(buf, 'euc-kr');
  } catch (error) {
    return text;
  }
}
