/**
 * Encoding utilities for handling text encoding issues
 */

const ICONV = require('iconv-lite');

export interface EncodingDetectionResult {
  encoding: string;
  confidence: number;
  decodedText: string;
}

/**
 * Normalize text encoding to prevent character corruption
 * Handles common encoding issues with Korean text
 */
export function normalizeTextEncoding(buffer: Buffer | string, defaultEncoding: string = 'utf-8'): string {
  try {
    if (typeof buffer === 'string') {
      return buffer;
    }

    const text = buffer.toString('utf-8');

    if (text.includes('') || text.includes('')) {
      const decoded = ICONV.decode(buffer, 'EUC-KR');
      return decoded.toString();
    }

    return text;
  } catch (error) {
    console.warn('Encoding normalization failed, using original text:', error);
    return typeof buffer === 'string' ? buffer : buffer.toString('utf-8');
  }
}

/**
 * Clean and normalize HTML content
 */
export function cleanHtmlContent(html: string): string {
  if (!html) return '';

  let cleaned = html;

  cleaned = cleaned.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  cleaned = cleaned.replace(/<[^>]+>/g, ' ');
  cleaned = cleaned.replace(/&nbsp;/g, ' ');
  cleaned = cleaned.replace(/&amp;/g, '&');
  cleaned = cleaned.replace(/&lt;/g, '<');
  cleaned = cleaned.replace(/&gt;/g, '>');
  cleaned = cleaned.replace(/&quot;/g, '"');
  cleaned = cleaned.replace(/&#39;/g, "'");
  cleaned = cleaned.replace(/&#\d+;/g, match => {
    const code = parseInt(match.substring(2, match.length - 1));
    return String.fromCharCode(code);
  });
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

/**
 * Validate if text appears to have encoding issues
 */
export function hasEncodingIssues(text: string): boolean {
  const issuePatterns = [
    /[À-ÿ]{2,}/,
    /Â[ÂÀÃÄÅ]/,
    /Ð[ÐÎÏ]/,
    /µ[µ¶·]/,
    /¿[¿¡]/,
    /[^\x00-\x7F]{10,}/
  ];

  return issuePatterns.some(pattern => pattern.test(text));
}

/**
 * Attempt to fix encoding issues
 */
export function fixEncodingIssues(text: string): string {
  if (!hasEncodingIssues(text)) {
    return text;
  }

  try {
    const buffer = Buffer.from(text, 'latin1');
    return buffer.toString('utf-8');
  } catch (error) {
    console.warn('Failed to fix encoding issues:', error);
    return text;
  }
}
