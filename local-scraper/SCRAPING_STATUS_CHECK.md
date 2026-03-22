# 스크래핑 페이지 검증 결과

## 🔍 확인 내용

### 1️⃣ 더벨 키워드 페이지
**URL**: https://www.thebell.co.kr/Member/MyKeywordNews.asp?mbrmenu=02

**현재 상태**: ❌ **문제 발견**

#### 🔴 문제점
- API 엔드포인트 `/api/thebell/scrape?category=news` 는 **메인 뉴스 페이지**만 스크래핑
- **MyKeywordNews 페이지를 스크래핑하지 않음**
- 코드에는 `scrapeKeywordNews()` 메서드 존재하지만, Express 라우트에 연결되지 않음

#### 📝 코드 상태
```typescript
// ThebellService.ts line 167 - 메서드 존재
async scrapeKeywordNews(maxPages: number = 50): Promise<ScrapingResult>

// 하지만 index.ts에 API 엔드포인트 없음!
// app.post('/api/thebell/scrape-keyword-news', ...) ← 필요함
```

#### 📊 현재 API 응답 (더벨 키워드 페이지 아님)
```json
{
  "success": true,
  "data": [15 articles from main deal page]
  // → /Member/MyKeywordNews.asp 이 아님!
}
```

---

### 2️⃣ 마켓인사이트 M&A 페이지
**URL**: https://marketinsight.hankyung.com/mna

**현재 상태**: ✅ **정상 작동**

#### 🟢 확인 완료
- API 엔드포인트 `/api/marketinsight/scrape?section=mna&page=1` 작동
- 최대 100페이지 수집 가능
- 16개 M&A 기사 수집 확인

#### 📊 API 응답 예시
```json
{
  "success": true,
  "data": [
    {
      "title": "정태순 회장 \"세계 1위 MSC와 협력 위해 장금마리타임 지분 판다\"",
      "link": "https://marketinsight.hankyung.com/article/2026032058611",
      "date": "2026-03-22",
      "category": "Buyout",
      "summary": "..."
    },
    ... (총 16개)
  ]
}
```

---

## 🛠️ 필요한 수정사항

### 문제 1: 더벨 키워드 페이지 API 엔드포인트 추가

#### 현재 상황
```typescript
// src/index.ts - 현재 코드
app.get('/api/thebell/scrape', async (req: Request, res: Response) => {
  const result = await thebellService.scrapeArticles('deal'); // ❌ 메인 페이지만
  res.json(result);
});
```

#### 수정 필요 사항
```typescript
// src/index.ts - 추가되어야 할 코드
app.get('/api/thebell/scrape-keyword-news', async (req: Request, res: Response) => {
  try {
    const maxPages = parseInt(req.query.maxPages as string) || 50;
    const result = await thebellService.scrapeKeywordNews(maxPages);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
```

---

## 📋 자동 수집 프로세스 (collectionService.ts)

### ✅ MarketInsight (정상)
```typescript
// Line 124
const listResult = await service.scrapeArticlesAllPages('mna', 100);
// ✅ 모든 페이지 수집 (최대 100페이지)
// ✅ M&A 전용 카테고리
```

### ✅ TheBell (정상)
```typescript
// Line 204
const listResult = await service.scrapeKeywordNews(50);
// ✅ MyKeywordNews 페이지 수집 (최대 50페이지)
// ✅ 사용자 등록 키워드 기반
```

**결론**: 자동 수집 로직은 올바르게 구현되어 있음!
문제는 **수동 API 테스트 엔드포인트**가 부족함

---

## 🚀 해결 방안

### Step 1: Express 라우트 추가
```typescript
// local-scraper/src/index.ts에 추가

// TheBell 마이페이지 키워드 뉴스 (모든 페이지)
app.get('/api/thebell/scrape-keyword-news', async (req: Request, res: Response) => {
  try {
    const maxPages = parseInt(req.query.maxPages as string) || 50;
    console.log(`[API] TheBell keyword news: max ${maxPages} pages`);
    const result = await thebellService.scrapeKeywordNews(maxPages);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
```

### Step 2: 빌드 및 재시작
```bash
npm run build
npm start
```

### Step 3: 테스트
```bash
curl "http://localhost:3001/api/thebell/scrape-keyword-news?maxPages=5"
```

---

## 📊 최종 검증 체크리스트

| 항목 | 상태 | URL | 비고 |
|------|------|-----|------|
| **MarketInsight M&A** | ✅ | `/api/marketinsight/scrape?section=mna` | 모든 페이지 수집 |
| **TheBell 키워드** | ❌ | API 엔드포인트 없음 | 메서드 존재하지만 라우트 미등록 |
| **자동 수집 (MI)** | ✅ | `scrapeArticlesAllPages()` | 정상 작동 |
| **자동 수집 (TB)** | ✅ | `scrapeKeywordNews()` | 정상 작동 |

---

## 💡 왜 자동 수집은 정상인가?

- `collectionService.ts`에서 **직접 메서드를 호출**
  ```typescript
  const listResult = await service.scrapeKeywordNews(50);
  ```
- Express 라우트를 거치지 않음
- API 엔드포인트 부재는 수동 테스트 시에만 문제됨

---

## ✅ 수정 후 예상 동작

### 테스트 API
```bash
# 더벨 키워드 뉴스 (첫 5페이지)
$ curl "http://localhost:3001/api/thebell/scrape-keyword-news?maxPages=5"

{
  "success": true,
  "data": [
    {
      "title": "...",
      "link": "https://www.thebell.co.kr/Member/MyKeywordNews.asp?...",
      "isPaid": true,
      "category": "keyword",
      "date": "2026-03-22"
    },
    ...
  ]
}
```

### 자동 수집
```
50~85분마다:
├─ MarketInsight M&A 페이지 (100 페이지)
└─ TheBell 키워드 페이지 (50 페이지)
   → 모두 정상 작동
```
