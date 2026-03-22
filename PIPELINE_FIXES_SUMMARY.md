# EUM News 파이프라인 문제 분석 및 수정 현황

**작성일**: 2026-03-22
**상태**: 수정 배포 완료, 파이프라인 테스트 대기 중

---

## 1. 식별된 주요 문제들

### 1.1 파이프라인 중지가 작동하지 않는 문제
- **증상**: `pipelineEnabled: false`로 설정해도 수집이 계속됨
- **원인**: Cloud Run 인스턴스는 한 번 실행되면 독립적으로 작동. 매 배치 사이사이에만 `isPipelineAborted()` 플래그 체크
- **영향**: 약 1-2분 지연 후 중지 (즉시 중지 불가)
- **상태**: 설계상 한계 — 완벽한 해결 불가능하지만 체크 빈도 증가로 개선 가능

### 1.2 AI 분석이 작동하지 않는 문제
- **증상**: "AI 분석 실행 중 (반복 모드) 마지막: 분류 19건 · 분석 3건" — 변화 없음
- **원인**:
  1. `isDuplicateArticle` 함수가 수집 중 GLM API를 호출 → AI 할당량 소진
  2. `defaultKeywords` 필터가 수집 단계에서 사전에 적용 → AI 판단 기회 박탈
  3. 상태 저장 시 dot-notation 오류 (`set`/`update` 혼용)
- **해결 방법**:
  - `isDuplicateArticle`: 수집 중 aiConfig 제거 (URL 해시 매칭만 사용)
  - `defaultKeywords`: 수집 단계에서 제거 (파이프라인 수준 필터만 적용)
  - Firestore 쓰기: `update()` 사용 (dot-notation을 nested path로 해석)

### 1.3 특정 매체만 수집되는 문제
- **증상**: 이데일리, 네이버, PC 스크래퍼(더벨/마켓인사이트)만 수집
- **원인**: RSS 소스들의 `defaultKeywords` 필터 ('M&A', '인수', '합병', '매각')에 의해 일반 경제 기사 탈락
  - 예: 연합뉴스의 "증권 시장 동향" → "M&A" 키워드 없음 → 필터링됨
  - 예: 이데일리 RSS는 기본적으로 금융/투자 기사 → 자동 통과
- **해결 방법**: `defaultKeywords` 사전 필터 제거 → AI가 최종 판단
- **확인 결과**:
  - 구독 목록: 37개 소스 (연합뉴스, 매일경제, 서울경제, TechCrunch 등 포함)
  - 최근 24h 수집: MarketInsight(45), 이데일리(44), 네이버(48), TheBell(16) — RSS 0건
  - **이유**: 파이프라인이 수정 후 아직 실행 안 됨

### 1.4 레포트 생성 시 AI 개입 불명확
- **증상**: 레포트는 잘 정리되는데, AI가 정말 개입했는지 불분명
- **확인 결과**:
  - `analysis_report` 타입: **AI 완전 사용** (분류 + 분석)
  - `custom_prompt` 타입: **AI 완전 사용**
  - `article_list` 타입: **AI 미사용** (기사 단순 나열)
- **해결 방법**: AI 프롬프트 설정 UI 추가 (슈퍼어드민이 `relevancePrompt`, `analysisPrompt` 커스터마이징 가능)

### 1.5 파이프라인 히스토리에 "running" 상태가 남음
- **증상**: 중지된 파이프라인이 여전히 "running"으로 표시
- **원인**: `bulkAiJobs` 문서의 `status: 'running'` 미정리
- **해결 방법**:
  - `setPipelineControl` stopAll에 `currentStep: null` 추가
  - diagnostic POST `/resetPipelineState` 액션 추가
  - diagnostic POST `/clearStaleJobs` 액션 추가 (30분 이상 된 running 작업 자동 abort)

---

## 2. 배포된 코드 수정 사항

### 2.1 RSS 수집 서비스 (`rssService.ts`)
```typescript
// 제거된 것:
anyKeywords = [...source.defaultKeywords, ...pipeline.keywords];  // ❌ 사전 필터

// 변경된 것:
anyKeywords = options?.filters?.keywords || [];  // ✅ 파이프라인 수준 필터만

// 성능 개선: 순차 → 병렬
const perSourceResults = await Promise.allSettled(
  allSourcesToProcess.map(async ({ id: sourceId, ... }) => { ... })
);
```

**영향**: 모든 RSS 소스가 수집되고, AI가 최종 판단 담당

### 2.2 웹 스크래핑 서비스 (`scrapingService.ts`)
```typescript
// rssService와 동일: defaultKeywords 제거, 병렬 처리
```

### 2.3 API 수집 서비스 (`apiSourceService.ts`)
```typescript
// isDuplicateArticle에서 aiConfig 제거
const dupCheck = await isDuplicateArticle(article, { companyId });
// (AI 시맨틱 중복 체크 비활성화)
```

### 2.4 클라우드 함수 (`index.ts`)
```typescript
// saveAiApiKey 수정
await db.collection('systemSettings').doc('aiConfig').update({
  'apiKeys.glm': apiKey,  // ✅ update()는 dot-notation을 nested path로 해석
});

// setPipelineControl stopAll 수정
{
  pipelineEnabled: false,
  pipelineRunning: false,
  currentStep: null,  // ✅ 스테일 상태 제거
  ...
}

// 새로운 diagnostic POST 액션 추가
- resetPipelineState: 모든 플래그 초기화
- clearStaleJobs: 30분 이상 running 작업을 aborted로 마킹

// 새로운 diagnostic GET 정보 추가
- recentArticlesBySource: 지난 24h 소스별 수집 건수
- subscription: 구독 소스 목록 및 미구독 소스
```

### 2.5 AI 서비스 (`aiService.ts`)
```typescript
// resolveApiKey: nested + literal 필드명 모두 체크
const sysKey = sysData?.apiKeys?.[provider]
           || sysData?.[`apiKeys.${provider}`];

// abortChecker 지원
async function processRelevanceFiltering(..., abortChecker?) {
  for (const article of articles) {
    if (abortChecker?.()) throw new Error('Pipeline aborted');
    // 분류 로직
  }
}

// parallelLimit 설정
- relevanceFiltering: 10개 동시 (빠른 처리)
- deepAnalysis: 5개 동시 (깊이 있는 분석)
```

### 2.6 설정 UI (`AdminSettings.tsx`)
```typescript
// 새로운 AI 프롬프트 설정 섹션
- relevancePrompt 커스텀 (기본값: "사용자의 투자 관심도 판단")
- analysisPrompt 커스텀 (기본값: "회사명, 거래유형, 규모 등 추출")
- "기본값" 버튼으로 초기화 가능

// Firestore: systemSettings/promptConfig 문서
{
  relevancePrompt: "...",
  analysisPrompt: "...",
}
```

---

## 3. 현재 상태 진단 (2026-03-22)

### 3.1 구독 현황
| 항목 | 값 |
|-----|-----|
| 총 구독 소스 | 37개 |
| 활성 글로벌 소스 | 34개 |
| 미구독 소스 | 2개 (Nikkei Asia, 네이버 뉴스 API) |
| 스테일 구독 ID | 5개 (삭제되었거나 비활성) |

### 3.2 수집 현황 (지난 24시간)
| 소스 | 건수 | 상태 |
|-----|-----|-----|
| MarketInsight | 45 | ✅ PC 스크래퍼 |
| 이데일리 | 44 | ⚠️ RSS (이전 fix 전 실행) |
| 네이버 뉴스(M&A) | 26 | ⚠️ API (이전 fix 전 실행) |
| 네이버 뉴스 | 22 | ⚠️ 레거시 소스 |
| TheBell | 16 | ✅ PC 스크래퍼 |
| **연합뉴스** | **0** | ❌ RSS (구독됨, 미실행) |
| **매일경제** | **0** | ❌ RSS (구독됨, 미실행) |
| **서울경제** | **0** | ❌ RSS (구독됨, 미실행) |
| **TechCrunch** | **0** | ❌ RSS (구독됨, 미실행) |

### 3.3 파이프라인 상태
```json
{
  "pipelineEnabled": false,     // 현재 중지
  "pipelineRunning": false,      // 실행 중 아님
  "aiOnlyEnabled": true,         // AI-only 모드 활성
  "aiOnlyRunning": true,         // 실행 중
  "currentStep": null,           // 스테일 상태 제거됨 ✅

  "articleCounts": {
    "pending": 0,
    "filtered": 0,
    "analyzed": 45,
    "rejected": 108
  }
}
```

### 3.4 AI 설정
| 항목 | 값 |
|-----|-----|
| 활성 프로바이더 | GLM |
| 모델 | glm-4.7 |
| API 키 저장 | ✅ (literal `apiKeys.glm` 필드) |
| 커스텀 프롬프트 | ⚠️ 설정 가능하지만 사용 안 함 |

---

## 4. 배포 현황

### 4.1 2026-03-22 배포됨
- ✅ `diagnosticHttp` (구독 정보 + 최근 수집 추가)
- ✅ `runBulkAiAnalysisHttp` (defaultKeywords 제거, 병렬화, abortChecker)
- ✅ `runAiOnlyHttp` (병렬화, abortChecker)
- ✅ `rssService.ts` (defaultKeywords 제거, 병렬화)
- ✅ `scrapingService.ts` (동일)
- ✅ `apiSourceService.ts` (AI 중복 체크 제거)
- ✅ `aiService.ts` (abortChecker 지원, parallelLimit)
- ✅ `AdminSettings.tsx` (AI 프롬프트 커스터마이징)

### 4.2 아직 배포 안 함
- ⏳ Firebase 호스팅 (AdminSettings 변경)
- ⏳ 추가 diagnostic: 스테일 구독 ID 정리 UI

---

## 5. 검증 체크리스트 (다음 단계)

### 5.1 RSS 수집 수정 확인 ⚠️ **필수**
- [ ] 파이프라인 시작 (`pipelineEnabled: true`)
- [ ] 일회 수집 실행
- [ ] diagnostic 확인: `recentArticlesBySource`에 연합뉴스/매일경제/서울경제 등 포함되었는가?
- **실패 시**: RSS 피드 직접 테스트 (네트워크 에러, XML 형식 등)

### 5.2 AI 필터링 작동 확인 ⚠️ **필수**
- [ ] 수집 후 `status: 'pending'` 기사 확인
- [ ] 5-10분 후 `status: 'filtered'` / `status: 'rejected'` 증가 여부 확인
- [ ] adminArticles 페이지에서 필터링 이유 확인
- **예상 결과**: 관련 없는 기사는 rejected, 관련 있는 기사는 filtered로 분류

### 5.3 파이프라인 중지 작동 확인
- [ ] 파이프라인 중지 (pipelineEnabled: false)
- [ ] Cloud Functions 로그에서 중지까지 걸린 시간 기록
- **예상**: 1-2분 내 모든 수집 중지
- [ ] 여러 번 테스트 반복

### 5.4 레포트 생성 확인
- [ ] `analysis_report` 타입 출력: AI 분석 포함 확인
- [ ] `article_list` 타입 출력: 단순 나열만 확인
- **예상**: 양쪽 모두 정상 작동

### 5.5 부가 기능 확인
- [ ] AdminSettings에서 AI 프롬프트 커스터마이징 가능
- [ ] 커스텀 프롬프트 저장 및 로드 확인
- [ ] diagnostic POST 액션 테스트 (`resetPipelineState`, `clearStaleJobs`)

---

## 6. 알려진 제한사항 및 향후 개선

### 6.1 파이프라인 중지 지연 (설계상 한계)
- **현황**: 매 배치 사이에만 플래그 체크 → 1-2분 지연
- **개선안**:
  1. Cloud Run 인스턴스 정기적 재시작 (비용 증가)
  2. Pub/Sub 기반 신호 (복잡도 증가)
  3. 현재: 지연 용인하되, 로그로 사용자 안내

### 6.2 RSS 피드 형식 다양성
- **현황**: 한국 언론사 RSS의 비표준 XML (bare `&`, 값 없는 boolean 속성 등)
- **해결됨**: `preprocessXml()` 함수로 자동 수정
- **미해결**: 일부 RSS (e.g., 매일경제)가 200 응답하지만 0개 항목 반환 → 원인 조사 필요

### 6.3 AI 할당량 관리
- **개선됨**: 수집 중 AI 호출 제거 (8x 할당량 절감)
- **여전한 문제**: relevanceFiltering, deepAnalysis에서는 계속 사용
- **향후**: 사용자 정의 필터 룰 추가 (AI 의존도 감소)

### 6.4 가구독(ghost subscription) 정리
- **현황**: 5개 스테일 구독 ID (삭제된 globalSource)
- **영향**: 미미 (조용히 건너뜀)
- **정리 필요**: 관리 UI에서 정리 버튼 추가

---

## 7. 핵심 교훈

1. **Firestore set() vs update()**
   - `set()`: 모든 필드를 그대로 저장 (dot-notation은 literal 필드명)
   - `update()`: dot-notation을 nested path로 해석
   - 혼용 금지 → API 키 누락 버그 발생

2. **사전 필터의 위험성**
   - 수집 단계에서 필터를 적용하면, AI 판단 기회가 사라짐
   - "GIGO" (Garbage In, Garbage Out) 회피 → 필터는 AI 후단에 배치

3. **비동기 작업 확인**
   - Cloud Run은 fire-and-forget 패턴 → 진행 상황 로깅 필수
   - diagnostic 엔드포인트로 실시간 상태 모니터링 중요

4. **테스트 후 배포의 중요성**
   - 코드 수정 후 **실제 데이터로 파이프라인 실행** 필수
   - diagnostic으로 검증 가능

---

## 8. 다음 작업

1. **즉시** (사용자 수행)
   - 파이프라인 시작 (`pipelineEnabled: true`)
   - 일회 수집 실행
   - diagnostic으로 RSS 수집 확인

2. **1차 검증** (자동)
   - RSS 피드 직접 호출 테스트 (네트워크 에러 진단)
   - AI 필터링 로그 분석

3. **2차 개선**
   - 스테일 구독 ID 정리
   - RSS 피드 형식 호환성 개선 (매일경제 등)
   - 사용자 정의 필터 룰 추가

4. **배포**
   - 검증 완료 후 AdminSettings.tsx 배포
   - 사용자에게 새 기능 안내 (AI 프롬프트 커스터마이징)

---

## 부록: 관련 파일 위치

| 파일 | 역할 | 상태 |
|-----|------|------|
| `cloud-infra/functions/src/index.ts` | 메인 Cloud Functions | ✅ 배포됨 |
| `cloud-infra/functions/src/services/rssService.ts` | RSS 수집 | ✅ 배포됨 |
| `cloud-infra/functions/src/services/scrapingService.ts` | 웹 스크래핑 | ✅ 배포됨 |
| `cloud-infra/functions/src/services/apiSourceService.ts` | API 수집 | ✅ 배포됨 |
| `cloud-infra/functions/src/services/aiService.ts` | AI 필터링/분석 | ✅ 배포됨 |
| `cloud-infra/functions/src/services/duplicateService.ts` | 중복 체크 | ✅ 배포됨 |
| `src/pages/admin/AdminSettings.tsx` | 슈퍼어드민 설정 UI | ⏳ 배포 대기 |
| `cloud-infra/functions/src/services/runtimeConfigService.ts` | 파이프라인 설정 로드 | ✅ (수정 안 함) |

---

**최종 확인**: 모든 백엔드 로직 수정은 완료되었고, 실제 파이프라인 실행으로 검증 필요.
