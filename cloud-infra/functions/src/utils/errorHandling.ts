import axios, { AxiosError } from 'axios';
import { validateApiKey } from './secretManager';

/**
 * HTTP 429 (Rate Limit) 에러가 발생할 때 지수 백오프로 재시도합니다.
 * @param fn - 재시도할 함수
 * @param maxRetries - 최대 재시도 횟수 (기본 3회)
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 4
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      // Axios 에러인지 확인
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        
        // 429 Rate Limit 또는 5xx 서버 오류인 경우만 재시도
        if (status === 429 || (status && status >= 500 && status < 600)) {
          if (attempt < maxRetries - 1) {
            // 지수 백오프: 2초, 4초, 8초...
            const retryAfterHeader = error.response?.headers?.['retry-after'];
            const retryAfterSeconds = Number(Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader);
            const baseDelay = Math.min(30000, Math.pow(2, attempt) * 2000);
            const retryAfterDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
              ? retryAfterSeconds * 1000
              : 0;
            const jitter = Math.floor(Math.random() * 1500);
            const waitTime = Math.max(baseDelay, retryAfterDelay) + jitter;
            console.warn(`Rate limited or server error (attempt ${attempt + 1}/${maxRetries}). Retrying after ${waitTime}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          }
        }
      }
      
      // 429/5xx가 아니면 즉시 실패
      throw error;
    }
  }
  
  throw lastError!;
}

// Re-export validateApiKey from secretManager for backward compatibility
export { validateApiKey };

/**
 * 빈 응답을 감지합니다.
 */
export function isEmptyResponse(data: any): boolean {
  if (!data) return true;
  if (Array.isArray(data) && data.length === 0) return true;
  if (typeof data === 'object' && Object.keys(data).length === 0) return true;
  return false;
}

/**
 * 에러가 일시적인지(재시도 가능) 영구적인지 판단합니다.
 */
export function isTemporaryError(error: Error): boolean {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status === 429 || status === 503 || status === 504 || !status;
  }
  return false;
}

/**
 * 에러 심각도 레벨
 */
export enum ErrorSeverity {
  LOW = 'low',         // 경고 수준, 무시 가능
  MEDIUM = 'medium',   // 주의 필요, 모니터링 대상
  HIGH = 'high',       // 즉각 대응 필요
  CRITICAL = 'critical' // 서비스 중단 수준
}

/**
 * 분류된 에러 정보
 */
export interface ClassifiedError {
  severity: ErrorSeverity;
  category: string;
  message: string;
  retryable: boolean;
  context?: Record<string, any>;
}

/**
 * 에러를 심각도와 카테고리로 분류합니다.
 */
export function classifyError(error: unknown, context?: Record<string, any>): ClassifiedError {
  const message = error instanceof Error ? error.message : String(error);

  // 네트워크/API 에러 분류
  if (error && typeof error === 'object' && 'isAxiosError' in error) {
    const axiosError = error as any;
    const status = axiosError.response?.status;

    if (status === 429) {
      return { severity: ErrorSeverity.MEDIUM, category: 'rate_limit', message, retryable: true, context };
    }
    if (status === 401 || status === 403) {
      return { severity: ErrorSeverity.HIGH, category: 'auth', message, retryable: false, context };
    }
    if (status && status >= 500) {
      return { severity: ErrorSeverity.HIGH, category: 'external_api', message, retryable: true, context };
    }
    if (!status) {
      return { severity: ErrorSeverity.MEDIUM, category: 'network', message, retryable: true, context };
    }
    return { severity: ErrorSeverity.LOW, category: 'http', message, retryable: false, context };
  }

  // Firebase/Firestore 에러
  if (message.includes('PERMISSION_DENIED')) {
    return { severity: ErrorSeverity.HIGH, category: 'firestore_permission', message, retryable: false, context };
  }
  if (message.includes('UNAVAILABLE') || message.includes('DEADLINE_EXCEEDED')) {
    return { severity: ErrorSeverity.MEDIUM, category: 'firestore_unavailable', message, retryable: true, context };
  }

  // GLM API 에러
  if (message.includes('GLM API Key') || message.includes('API Key not configured')) {
    return { severity: ErrorSeverity.CRITICAL, category: 'api_key_missing', message, retryable: false, context };
  }
  if (message.includes('insufficient_quota') || message.includes('quota')) {
    return { severity: ErrorSeverity.HIGH, category: 'api_quota', message, retryable: false, context };
  }

  // JSON 파싱 에러
  if (message.includes('JSON') || message.includes('parse')) {
    return { severity: ErrorSeverity.LOW, category: 'parse_error', message, retryable: false, context };
  }

  // Puppeteer 에러
  if (message.includes('Puppeteer') || message.includes('browser') || message.includes('navigation')) {
    return { severity: ErrorSeverity.MEDIUM, category: 'scraping', message, retryable: true, context };
  }

  // 기본 분류
  return { severity: ErrorSeverity.MEDIUM, category: 'unknown', message, retryable: isTemporaryError(error as Error), context };
}

/**
 * 분류된 에러를 Firestore에 로깅합니다.
 * 심각도가 HIGH 이상인 경우에만 저장합니다.
 */
export async function logError(classified: ClassifiedError): Promise<void> {
  // LOW 심각도는 로깅하지 않음 (console.warn으로만 처리)
  if (classified.severity === ErrorSeverity.LOW) {
    console.warn(`[${classified.category}] ${classified.message}`);
    return;
  }

  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();

    await db.collection('systemErrors').add({
      severity: classified.severity,
      category: classified.category,
      message: classified.message.substring(0, 1000),
      retryable: classified.retryable,
      context: classified.context ? JSON.stringify(classified.context).substring(0, 2000) : null,
      resolved: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const logMethod = classified.severity === ErrorSeverity.CRITICAL ? 'error' : 'warn';
    console[logMethod](`[${classified.severity.toUpperCase()}][${classified.category}] ${classified.message}`);
  } catch (loggingError) {
    // 로깅 자체가 실패하면 콘솔로만 출력
    console.error(`Failed to log error to Firestore:`, loggingError);
    console.error(`Original error: [${classified.severity}][${classified.category}] ${classified.message}`);
  }
}
