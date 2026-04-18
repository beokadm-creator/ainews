import { HttpsError } from 'firebase-functions/v2/https';

const SAFE_MESSAGES: Record<string, string> = {
  'permission-denied': '접근 권한이 없습니다.',
  'unauthenticated': '로그인이 필요합니다.',
  'invalid-argument': '잘못된 요청입니다.',
  'not-found': '요청한 리소스를 찾을 수 없습니다.',
  'internal': '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
};

export function throwSafeError(code: string, internalError?: unknown): never {
  if (internalError) {
    // 내부 에러는 서버 콘솔에만 로깅 (클라이언트에 노출되지 않음)
    console.error(`[Internal ${code}]`, internalError);
  }
  
  // 클라이언트에는 안전하고 규격화된 메시지만 전달
  const safeMessage = SAFE_MESSAGES[code] || '오류가 발생했습니다.';
  throw new HttpsError(code as any, safeMessage);
}
