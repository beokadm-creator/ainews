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
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedPromptTemplates = seedPromptTemplates;
const admin = __importStar(require("firebase-admin"));
/**
 * 프롬프트 템플릿 초기 데이터 시딩
 * 이 함수는 한 번만 실행하여 Firestore에 기본 프롬프트를 저장합니다.
 */
async function seedPromptTemplates() {
    const db = admin.firestore();
    const batch = db.batch();
    const now = admin.firestore.FieldValue.serverTimestamp();
    const templates = [
        {
            name: 'M&A 관련성 필터링 (기본)',
            version: '1.0.0',
            stage: 'relevance-check',
            prompt: `당신은 M&A(인수합병) 전문가입니다. 다음 뉴스가 M&A와 관련이 있는지 판단해주세요.

1. ✅ 포함해야 할 주제:
   - 기업 간 인수·합병(M&A)
   - PEF(사모펀드) 관련 M&A
   - 벤처캐피탈(VC) 투자
   - 기업 매각·분할·스핀오프
   - 투자유치(IR, 펀드레이징)
   - IPO 관련 M&A
   - 재무적 투자자(Financial Sponsor) 관련 뉴스

2. ❌ 제외해야 할 주제:
   - 일반 주식 시황, 주가 변동
   - 순수 부동산 매매 (M&A 제외)
   - 정치적 이슈, 선거 관련 뉴스
   - 개인 투자자 관련 일반 정보
   - 일반 경제 뉴스 (금리, 환율 등)

RELEVANT: YES 또는 NO
CONFIDENCE: 0.0에서 1.0 사이의 숫자
REASON: 1-2문장 이유`,
            variables: ['title', 'content', 'source'],
            active: true,
            createdAt: now,
            updatedAt: now
        },
        {
            name: 'M&A 심층 분석 (기본)',
            version: '1.0.0',
            stage: 'deep-analysis',
            prompt: `당신은 M&A/사모펀드 전문 애널리스트입니다. 다음 기사를 분석하여 핵심 정보를 추출하고 한국어로 요약해주세요.

## 추출해야 할 정보
1. 기업 정보 (영문 기업명은 가급적 한글로 병기)
2. 거래 정보 (유형, 규모, 지분율)
3. 3줄 요약 (한국어)
4. 카테고리 분류
5. 시사점 (선택)

출력 형식: JSON`,
            variables: ['title', 'content', 'source', 'url', 'publishedAt'],
            active: true,
            createdAt: now,
            updatedAt: now
        },
        {
            name: '데일리 브리핑 생성 (기본)',
            version: '1.0.0',
            stage: 'daily-briefing',
            prompt: `사모펀드 전문 애널리스트로서 오늘의 M&A 뉴스를 종합하여 데일리 브리핑을 작성해주세요.

## 작성해야 할 섹션
1. 오늘의 하이라이트 (Top 3)
2. 섹터별 트렌드
3. 이음PE 인사이트
4. 내일 주목할 이슈`,
            variables: ['newsList'],
            active: true,
            createdAt: now,
            updatedAt: now
        },
        {
            name: '중복 기사 감지',
            version: '1.0.0',
            stage: 'dedup-check',
            prompt: `다음 두 기사가 같은 사건을 다루는 중복 기사인지 판단해주세요.

DUPLICATE: YES 또는 NO
REASON: 1-2문장 이유
SIMILARITY: HIGH/MEDIUM/LOW`,
            variables: ['title_a', 'content_a', 'date_a', 'source_a', 'title_b', 'content_b', 'date_b', 'source_b'],
            active: true,
            createdAt: now,
            updatedAt: now
        }
    ];
    for (const template of templates) {
        const docRef = db.collection('promptTemplates').doc();
        batch.set(docRef, { ...template });
    }
    await batch.commit();
    console.log(`Seeded ${templates.length} prompt templates`);
}
//# sourceMappingURL=promptTemplates.js.map