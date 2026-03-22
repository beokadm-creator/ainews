# AI News Local Scraper - 시스템 아키텍처 & 통신 가이드

## 📋 목차
1. [아키텍처 개요](#아키텍처-개요)
2. [컴포넌트 설명](#컴포넌트-설명)
3. [데이터 플로우](#데이터-플로우)
4. [API 인터페이스](#api-인터페이스)
5. [Firebase 연동](#firebase-연동)
6. [보안 & 인증](#보안--인증)
7. [성능 & 최적화](#성능--최적화)

---

## 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────────┐
│                    WINDOWS PC (로컬 환경)                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────────┐         ┌──────────────────┐             │
│  │  Chrome Browser  │         │   Node.js Server │             │
│  │  (포트 9222)     │◄───────►│   (포트 3001)    │             │
│  │  원격 디버깅     │         │  Local Scraper   │             │
│  └──────────────────┘         └──────────────────┘             │
│         ▲                              │                         │
│         │ Puppeteer 연결               │                         │
│         │ (WebSocket)                  │ Express API             │
│         │                              │ (HTTP/REST)             │
│         │                              ▼                         │
│         │                      ┌──────────────────┐             │
│         │                      │  Service 계층     │             │
│         │                      ├──────────────────┤             │
│         │                      │ MarketInsight    │             │
│         │                      │ Service          │             │
│         │                      │                  │             │
│         │                      │ TheBell          │             │
│         │                      │ Service          │             │
│         │                      └──────────────────┘             │
│         │                              │                         │
│         │                              ▼                         │
│         │                      ┌──────────────────┐             │
│         │                      │  Firestore SDK   │             │
│         │                      │  (Admin SDK)     │             │
│         │                      └──────────────────┘             │
│         │                              │                         │
│  ┌──────┴──────────────────────────────┴─────────┐             │
│  │         자동 수집 스케줄러                       │             │
│  │  (50~85분 랜덤 + 업무시간 제한)               │             │
│  └─────────────────────────────────────────────┘             │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
                    인터넷 연결 필요
                              │
                              ▼
                 ┌────────────────────────┐
                 │   Firebase (클라우드)   │
                 ├────────────────────────┤
                 │ Firestore Database     │
                 │ - articles            │
                 │ - paidSourceAccess    │
                 │ - outputs             │
                 └────────────────────────┘
```

---

## 컴포넌트 설명

### 1. Chrome 브라우저 (포트 9222)
**역할**: 웹 스크래핑을 위한 실제 브라우저 엔진 제공

```bash
# 실행 방식
# 1. 자동 부팅 시작: Windows 시작 프로그램 등록
# 2. 수동 실행: .\start-chrome-background.bat

# 원격 디버깅 포트 9222로 실행
chrome.exe --remote-debugging-port=9222 --disable-background-networking
```

**특징**:
- ✅ 사람처럼 보이는 스크래핑 (Puppeteer-extra Stealth Plugin)
- ✅ 세션 유지 (쿠키 저장/복구)
- ✅ JavaScript 렌더링 지원
- ✅ 이미지 로딩 및 동적 콘텐츠 처리

**쿠키 저장 위치**:
```
cookies/
├── marketinsight.json     # 마켓인사이트 로그인 상태
└── thebell.json           # 더벨 로그인 상태
```

---

### 2. Node.js 로컬 스크래퍼 서버 (포트 3001)

#### 2.1 Express 서버 구조
```typescript
// src/index.ts
const app = express();

// 초기화 단계
- marketInsightService.init()      // Chrome 9222 연결
- thebellService.init()            // Chrome 9222 연결
- initFirestore()                  // Firebase Admin SDK 초기화

// 자동 수집 스케줄러 시작
startAutoCollect()                 // 50~85분 랜덤 간격
```

**포트 구조**:
```
로컬 호스트
└── http://localhost:3001
    ├── /health                           (GET)  헬스 체크
    ├── /api/marketinsight/login          (POST) 로그인
    ├── /api/marketinsight/scrape         (GET)  스크래핑
    ├── /api/thebell/login                (POST) 로그인
    ├── /api/thebell/scrape               (GET)  스크래핑
    ├── /api/collect/manual               (POST) 수동 수집
    └── /api/collection/status            (GET)  수집 상태 조회
```

---

### 3. 서비스 계층 (Service Layer)

#### 3.1 MarketInsightService
**역할**: 마켓인사이트 웹사이트 스크래핑

```typescript
// 생명주기
init()                    // Chrome 9222 연결
login(email, password)    // 로그인 (쿠키 저장)
scrapeArticles()          // 기사 목록 수집
getArticleDetail()        // 상세 내용 수집
close()                   // 리소스 정리
```

**스크래핑 대상**:
- 섹션: `mna` (M&A), `pe` (사모펀드), `ipo` (상장) 등
- 페이지 네이션 지원
- 제목, 링크, 날짜, 전체 기사 본문 추출

**인증 방식**:
```
마켓인사이트 로그인
    ↓
(이메일 + 비밀번호)
    ↓
Chrome에서 자동 로그인
    ↓
쿠키 저장 (cookies/marketinsight.json)
    ↓
다음 실행 시 쿠키로 로그인 상태 복구
```

#### 3.2 ThebellService
**역할**: 더벨 웹사이트 스크래핑 (M&A 특화)

```typescript
// 생명주기
init()                    // Chrome 9222 연결
login(email, password)    // 로그인
scrapeArticles()          // 기사 목록 (키워드 필터링)
getArticleDetail()        // 상세 내용 + 정체정보
close()                   // 리소스 정리
```

**키워드 필터링** (관련도 스코어링):
```
HIGH_VALUE_KEYWORDS (점수 +2)
- 인수합병, M&A, 바이아웃, 경영권 인수
- 사모펀드, PEF, 프라이빗에쿠어티
- 인수금융, EXIT, 엑시트

DEAL_KEYWORDS (점수 +1)
- 인수, 매각, 매물, 투자, IPO, 상장
- 블록딜, 합병, 분할, 펀드 결성

점수 기반 자동 필터링: score >= 1인 기사만 수집
```

---

### 4. 수집 관리 계층 (Collection Service)

#### 4.1 자동 수집 스케줄러
```typescript
// 50~85분 랜덤 간격으로 반복
function randomCollectIntervalMs(): number {
  const minMin = 50, maxMin = 85;
  return (minMin + Math.floor(Math.random() * (maxMin - minMin))) * 60 * 1000;
}

// 한국 업무시간 필터링 (07:00 ~ 23:00 KST)
function isKoreanBusinessHours(): boolean {
  const kstHour = (new Date().getUTCHours() + 9) % 24;
  return kstHour >= 7 && kstHour < 23;
}
```

**특징**:
- ✅ 업무시간만 작동 (야간 수집 방지)
- ✅ 랜덤 간격 (정각 요청 방지 → 봇 탐지 회피)
- ✅ 사람처럼 랜덤 딜레이 (3~8초 대기)
- ✅ 중복 검사 (URL 해시 기반)

#### 4.2 수집 프로세스

```
collectAllArticles() 실행
    ↓
├─ MarketInsight 수집 (권한이 있는 회사들)
│   ├─ 기사 목록 수집
│   ├─ 관련도 스코어링
│   ├─ 상위 N개 상세 내용 추출
│   └─ Firestore에 회사별로 저장
│
├─ 5~15초 랜덤 대기 (자연스러운 간격)
│
└─ TheBell 수집 (권한이 있는 회사들)
    ├─ 기사 목록 수집 (M&A 키워드만)
    ├─ 관련도 스코어링
    ├─ 상위 N개 상세 내용 추출
    └─ Firestore에 회사별로 저장
```

---

## 데이터 플로우

### 1. 자동 수집 플로우

```
┌─────────────────────┐
│  자동 스케줄러 시작   │ (서버 시작 후 30~90초)
└──────────┬──────────┘
           │
           ▼
┌──────────────────────────┐
│ 한국 업무시간 확인        │
│ (07:00~23:00 KST)       │
└──────┬──────────┬───────┘
       │ YES      │ NO
       │          └──► 재스케줄 (업무시간까지 대기)
       │
       ▼
┌──────────────────────────────────────────────┐
│ 1. 권한 확인                                  │
│    - Firestore paidSourceAccess/{sourceId}   │
│      에서 authorizedCompanyIds 조회           │
│    - MarketInsight 권한 회사 목록            │
│    - TheBell 권한 회사 목록                  │
└──────┬───────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────┐
│ 2. MarketInsight 수집 (병렬 처리 가능)        │
│    FOR each authorized company:              │
│      - 기사 목록 조회                        │
│      - 관련도 스코어링                      │
│      - 상세 내용 추출 (max 8개)             │
│      - 중복 체크 (URL 해시)                 │
│      - Firestore 저장                       │
└──────┬───────────────────────────────────────┘
       │
       ▼ (5~15초 대기)
       │
┌──────────────────────────────────────────────┐
│ 3. TheBell 수집 (M&A 특화)                   │
│    FOR each authorized company:              │
│      - 기사 목록 조회                        │
│      - M&A 키워드 필터링                    │
│      - 관련도 스코어링                      │
│      - 상세 내용 추출                       │
│      - 중복 체크 (URL + 회사ID)             │
│      - Firestore 저장                       │
└──────┬───────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ 4. 수집 완료 로깅            │
│    - 총 수집 기사 수          │
│    - 소스별 통계              │
│    - 오류 로그                │
└──────┬──────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ 5. 다음 수집 스케줄 예약      │
│    (50~85분 후)              │
└──────────────────────────────┘
```

### 2. 중복 제거 메커니즘

```typescript
// URL 기반 중복 체크
interface ArticleCheckpoint {
  urlHash: string;        // URL의 MD5 해시
  companyId: string;      // 회사 ID (같은 URL도 회사별로 구분)
}

// Firestore articles 컬렉션 구조
articles/{docId}
├── urlHash              // "abc123def..."
├── companyId            // "company_1"
├── title               // "삼성전자, SK네트웍스 인수..."
├── url                 // "https://..."
├── content             // "전체 기사 본문..."
├── publishedAt         // 2024-03-20T10:30:00Z
├── source              // "marketinsight" | "thebell"
├── sourceId            // "marketinsight" | "thebell"
├── category            // "M&A"
├── relevanceScore      // 3 (HIGH_VALUE_KEYWORDS 2점 + DEAL_KEYWORDS 1점)
└── collectedAt         // 수집 시간
```

**중복 체크 로직**:
```typescript
// 같은 회사, 같은 URL = 이미 수집함 (스킵)
// 다른 회사, 같은 URL = 다시 저장 (회사별 구분)
// 같은 회사, 다른 URL = 새 기사 (저장)
```

---

## API 인터페이스

### 1. 헬스 체크
```http
GET http://localhost:3001/health

Response:
{
  "status": "ok",
  "timestamp": "2024-03-20T14:30:45.123Z"
}
```

### 2. MarketInsight 로그인
```http
POST http://localhost:3001/api/marketinsight/login
Content-Type: application/json

Request:
{
  "email": "user@example.com",
  "password": "password123"
}

Response:
{
  "success": true,
  "message": "Login successful"
}
```

### 3. MarketInsight 스크래핑
```http
GET http://localhost:3001/api/marketinsight/scrape?section=mna&page=1

Response:
{
  "success": true,
  "data": [
    {
      "title": "삼성전자, 외국계 기업 인수",
      "link": "https://marketinsight.hankyung.com/...",
      "date": "2024-03-20",
      "content": "상세 기사 본문..."
    },
    ...
  ]
}
```

### 4. TheBell 로그인
```http
POST http://localhost:3001/api/thebell/login
Content-Type: application/json

Request:
{
  "email": "user@example.com",
  "password": "password123"
}

Response:
{
  "success": true,
  "message": "Login successful"
}
```

### 5. TheBell 스크래핑
```http
GET http://localhost:3001/api/thebell/scrape?category=news

Response:
{
  "success": true,
  "data": [
    {
      "title": "대형 M&A 거래 성사",
      "link": "https://www.thebell.co.kr/...",
      "date": "2024-03-20",
      "isPaid": true,
      "category": "M&A News",
      "summary": "기사 요약..."
    },
    ...
  ]
}
```

### 6. 수동 수집 트리거
```http
POST http://localhost:3001/api/collect/manual
Content-Type: application/json

Request:
{
  "skipBusinessHoursCheck": false  // 업무시간 제한 무시 여부
}

Response:
{
  "success": true,
  "marketinsight": {
    "found": 25,
    "relevant": 15,
    "detailFetched": 8,
    "collected": 7,
    "skipped": 1,
    "errors": []
  },
  "thebell": {
    "found": 18,
    "relevant": 12,
    "detailFetched": 8,
    "collected": 8,
    "skipped": 0,
    "errors": []
  },
  "totalCollected": 15,
  "firestoreEnabled": true
}
```

---

## Firebase 연동

### 1. Firestore 초기화

```typescript
// src/services/firestoreService.ts

// 방법 1: 서비스 계정 (권장)
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'eumnews-9a99c',
});

// 방법 2: 환경 변수 설정
process.env.FIREBASE_SERVICE_ACCOUNT_PATH = '/path/to/service-account.json';
process.env.FIREBASE_PROJECT_ID = 'eumnews-9a99c';
```

### 2. 권한 조회

```typescript
// Firestore에서 유료 소스 접근 권한 확인
async function getAuthorizedCompanyIds(sourceId: string): Promise<string[]> {
  const db = admin.firestore();
  const doc = await db.collection('paidSourceAccess').doc(sourceId).get();
  if (!doc.exists) return [];
  return (doc.data()?.authorizedCompanyIds as string[]) || [];
}

// 호출 예
const miCompanies = await getAuthorizedCompanyIds('marketinsight');
// → ['company_1', 'company_2', 'company_3']
```

### 3. 기사 저장

```typescript
// 특정 회사에 기사 저장
async function saveArticleForCompany(
  article: ArticleData,
  companyId: string,
): Promise<boolean> {
  const db = admin.firestore();

  // URL 해시로 중복 체크
  const urlHash = hashUrl(article.url);
  const existing = await db.collection('articles')
    .where('urlHash', '==', urlHash)
    .where('companyId', '==', companyId)
    .limit(1)
    .get();

  if (!existing.empty) {
    return false;  // 중복이므로 스킵
  }

  // 새 기사 저장
  await db.collection('articles').add({
    ...article,
    urlHash,
    companyId,
    collectedAt: new Date(),
  });

  return true;  // 저장됨
}
```

### 4. Firestore 컬렉션 구조

```
Firestore Database (eumnews-9a99c)
│
├─ articles/                          # 수집된 기사들
│  └─ {docId}
│     ├── title: string
│     ├── url: string
│     ├── urlHash: string (MD5)
│     ├── content: string
│     ├── publishedAt: timestamp
│     ├── source: "marketinsight" | "thebell"
│     ├── sourceId: string
│     ├── companyId: string          # 어느 회사가 볼 수 있는 기사
│     ├── category: string
│     ├── relevanceScore: number
│     ├── collectedAt: timestamp
│     └── status: "pending" | "analyzed" | "published"
│
├─ paidSourceAccess/                 # 유료 매체 접근 권한
│  ├─ marketinsight
│  │  └── authorizedCompanyIds: ["company_1", "company_2"]
│  │
│  └─ thebell
│     └── authorizedCompanyIds: ["company_1", "company_3"]
│
└─ outputs/                           # AI 분석 결과
   └─ {docId}
      ├── companyId: string
      ├── pipelineId: string
      ├── briefing: object
      ├── createdAt: timestamp
      └── status: string
```

---

## 보안 & 인증

### 1. Chrome 세션 보안

```typescript
// 쿠키 저장 (파일 기반)
private saveCookies(cookies: any[]): void {
  const cookiesPath = path.join(__dirname, '../../cookies/marketinsight.json');
  fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
  // 파일 권한: 소유자만 읽기 (chmod 600)
}

// 쿠키 로드 (기존 세션 복구)
private loadCookies(): any[] {
  const cookiesPath = path.join(__dirname, '../../cookies/marketinsight.json');
  if (fs.existsSync(cookiesPath)) {
    return JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
  }
  return [];
}
```

**주의사항**:
- 쿠키 파일은 로컬 PC에만 저장
- 원격 서버에 업로드하지 않음
- `.gitignore`에 포함되어 버전 관리 제외

### 2. Firebase 인증

```typescript
// 환경 변수로 관리
process.env.FIREBASE_SERVICE_ACCOUNT_PATH = 'C:/path/to/serviceAccount.json';
process.env.FIREBASE_PROJECT_ID = 'eumnews-9a99c';

// 서비스 계정으로 인증 (관리자 권한)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId,
});

// Firestore 규칙으로 접근 제어
// 📍 rules_v2.txt 참고
```

### 3. Puppeteer Stealth 플러그인

```typescript
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());
// ✅ 봇 탐지 우회
// ✅ WebDriver 속성 숨김
// ✅ Chrome 자동화 흔적 제거
```

### 4. 봇 탐지 회피 전략

```typescript
// 사람처럼 동작하는 대기
async function humanDelay(minMs = 3000, maxMs = 8000): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * (maxMs - minMs));
  await new Promise(r => setTimeout(r, ms));
}

// 특징:
✅ 3~8초 랜덤 대기 (사람의 행동 속도)
✅ 50~85분 수집 간격 (정각 출발 방지)
✅ 업무시간만 작동 (자연스러운 패턴)
✅ User-Agent 설정 (구글 크롬 표준)
✅ 스크롤, 클릭 랜덤화 (마우스 이동)
```

---

## 성능 & 최적화

### 1. 메모리 관리

```typescript
// Chrome 인스턴스 공유 (메모리 절약)
async init(): Promise<void> {
  try {
    // 기존 Chrome 포트 9222 연결
    const response = await axios.get('http://localhost:9222/json/version');
    const wsUrl = response.data.webSocketDebuggerUrl;
    this.browser = await puppeteer.connect({
      browserWSEndpoint: wsUrl,
      defaultViewport: null,
      protocolTimeout: 180000,
    });
    // ✅ 새 프로세스 생성 안 함
    // ✅ 기존 프로세스 재사용
  } catch {
    // fallback: 없으면 새로 시작
    this.browser = await puppeteer.launch({ headless: true });
  }
}
```

**메모리 절약 기법**:
- Chrome 원격 연결 (별도 프로세스)
- Page 내용 직렬화 (큰 DOM 메모리 누수 방지)
- 주기적 페이지 종료
- 메모리 누수 모니터링

### 2. 병렬 처리

```typescript
// 회사별 병렬 수집
async function collectMarketInsight(
  service: MarketInsightService,
  companies: string[],
  result: SourceResult,
) {
  const promises = companies.map(companyId =>
    collectForCompany(service, companyId, result)
  );
  await Promise.allSettled(promises);  // 하나 실패해도 계속 진행
}

// 최대 동시 페이지 수 제한
const MAX_CONCURRENT_PAGES = 3;
```

### 3. 에러 핸들링 & 재시도

```typescript
// 자동 재시도 (최대 3회)
async function scrapWithRetry(
  page: Page,
  url: string,
  maxRetries = 3,
): Promise<any> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      return await page.content();
    } catch (error) {
      if (i < maxRetries - 1) {
        await humanDelay(5000, 10000);  // 대기 후 재시도
      } else {
        throw error;  // 최종 실패
      }
    }
  }
}
```

### 4. 로깅 & 모니터링

```typescript
// 구조화된 로깅
console.log('[Collection] ✓ Complete | MI: 7 saved (15/25 relevant) | TB: 8 saved (12/18 relevant)');
console.log('[AutoCollect] Next collection in ~67 min');
console.log('[MarketInsight] Error: Login failed - ${error.message}');

// 로그 기록 위치
local-scraper/logs/
├── pm2-error.log          # PM2 에러
├── pm2-out.log            # PM2 표준 출력
└── scraper-detailed.log   # 커스텀 로그 (수동 추가 가능)
```

---

## 통신 시스템 요약

### 전체 통신 흐름

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. Windows 부팅                                                   │
└────────┬─────────────────────────────────────────────────────────┘
         │
         ├─► Chrome 시작 (포트 9222) ← Windows 시작 프로그램
         │        ↓
         │   로그인 상태 복구 (쿠키 로드)
         │
         └─► Node.js 서버 시작 (포트 3001) ← PM2 자동 시작
                  ↓
              Express 초기화
                  ↓
              MarketInsightService.init() ──┐
              ThebellService.init()        ──┼─► Chrome 9222 연결
              initFirestore()              ──┤    (Puppeteer)
                  ↓                        ──┘
              자동 수집 스케줄러 시작 (50~85분 간격)
                  │
                  ├─► 업무시간 확인 (07:00~23:00 KST)
                  │
                  ├─► Firestore 권한 조회
                  │   paidSourceAccess/{sourceId}
                  │   → authorizedCompanyIds 로드
                  │
                  ├─► MarketInsight 수집 (병렬)
                  │   FOR each authorized company:
                  │   - 기사 목록 조회 (Chrome 렌더링)
                  │   - 상세 내용 추출 (크롤링)
                  │   - 관련도 스코어링 (키워드 매칭)
                  │   - Firestore 저장 (회사별)
                  │
                  ├─► 5~15초 대기 (자연스러운 간격)
                  │
                  ├─► TheBell 수집 (병렬)
                  │   FOR each authorized company:
                  │   - 기사 목록 조회 (M&A 키워드만)
                  │   - 상세 내용 추출
                  │   - 관련도 스코어링
                  │   - Firestore 저장
                  │
                  └─► 다음 수집 스케줄 (50~85분 후)
```

### 실시간 모니터링

```bash
# 로컬 스크래퍼 상태 확인
pm2 status

# 실시간 로그 모니터링
pm2 logs ainews-local-scraper

# Chrome 포트 확인
curl http://localhost:9222/json/version

# 로컬 스크래퍼 헬스 체크
curl http://localhost:3001/health

# 수집 상태 조회 (응답 예제)
{
  "marketinsight": {
    "found": 25,
    "relevant": 15,
    "detailFetched": 8,
    "collected": 7,
    "skipped": 1,
    "errors": []
  },
  "thebell": {
    "found": 18,
    "relevant": 12,
    "detailFetched": 8,
    "collected": 8,
    "skipped": 0,
    "errors": []
  },
  "totalCollected": 15
}
```

---

## 문제 해결 (Troubleshooting)

### 포트 충돌
```bash
# 포트 3001 확인
netstat -ano | findstr :3001

# 사용 중인 프로세스 종료
taskkill /PID <PID> /F
```

### Chrome 연결 실패
```bash
# Chrome 포트 9222 확인
netstat -ano | findstr :9222

# 포트 9222 사용 중이면 기존 Chrome 종료
taskkill /F /IM chrome.exe

# 원격 디버깅으로 다시 시작
.\start-chrome-background.bat
```

### Firestore 연결 오류
```
Error: [Firestore] Init failed: Service account not found
해결: FIREBASE_SERVICE_ACCOUNT_PATH 환경 변수 확인
```

---

## 📊 성능 지표

| 항목 | 목표값 | 현재값 |
|------|-------|--------|
| 수집 간격 | 50~85분 | ✅ |
| 업무시간 준수 | 07:00~23:00 KST | ✅ |
| 사람처럼 대기 | 3~8초 | ✅ |
| 중복 제거율 | 100% | ✅ |
| 메모리 사용량 | <200MB | 테스트 필요 |
| CPU 사용률 | <20% | 테스트 필요 |
| Firestore 읽기 비용 | 월 <1,000회 | 테스트 필요 |

---

## 🎯 다음 단계

1. ✅ 로컬 스크래퍼 자동 시작 검증
2. ⏳ 72시간 연속 운영 테스트
3. ⏳ Firestore 비용 모니터링
4. ⏳ 봇 탐지 우회 성능 측정
5. ⏳ 기사 품질 평가 (정확도, 완성도)
