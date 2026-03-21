# 로컬 스크래핑 서버 (Local Scraping Server)

마켓인사이트(MarketInsight)와 더벨(Thebell)에서 기사를 스크래핑하는 로컬 Node.js 서버입니다. 장비 인증(HK_Device_Detector) 필요로 하는 사이트들을 Windows PC에서 직접 처리합니다.

## 요구사항 (Requirements)

- Node.js v18 이상
- npm 또는 yarn
- Windows 10/11
- Puppeteer가 작동하는 환경 (Chrome 자동 다운로드)

## 설치 (Installation)

```bash
cd local-scraper
npm install
npm run build
```

## 실행 (Running)

### 개발 모드 (Development)
```bash
npm run dev
```

### 프로덕션 모드 (Production)
```bash
npm start
```

서버는 기본적으로 `http://localhost:3001`에서 실행됩니다.

포트를 변경하려면:
```bash
set PORT=8080
npm start
```

## API 엔드포인트 (API Endpoints)

### Health Check
```
GET http://localhost:3001/health
```

**응답:**
```json
{ "status": "ok", "timestamp": "2024-03-21T10:00:00.000Z" }
```

### 마켓인사이트 로그인
```
POST http://localhost:3001/api/marketinsight/login
Content-Type: application/json

{
  "email": "your@email.com",
  "password": "your_password"
}
```

**응답:**
```json
{ "success": true, "message": "Login successful" }
```

### 마켓인사이트 기사 스크래핑
```
GET http://localhost:3001/api/marketinsight/scrape?category=mna
```

**응답:**
```json
{
  "success": true,
  "data": [
    {
      "title": "기사 제목",
      "link": "https://...",
      "date": "2024-03-21"
    }
  ]
}
```

### 더벨 로그인
```
POST http://localhost:3001/api/thebell/login
Content-Type: application/json

{
  "email": "user_id",
  "password": "user_password"
}
```

### 더벨 기사 스크래핑
```
GET http://localhost:3001/api/thebell/scrape?category=news
```

## Cloud Run에서 호출하기 (Calling from Cloud Run)

Cloud Run 함수에서 이 로컬 서버를 호출하려면, 로컬 PC의 공개 IP나 도메인을 사용해야 합니다.

### 예시 (Example)

```typescript
// Cloud Run에서
const response = await fetch('http://YOUR_PC_IP:3001/api/marketinsight/scrape', {
  method: 'GET',
});
const result = await response.json();
```

**주의:**
- 로컬 PC가 켜져 있어야 함
- 방화벽에서 포트 3001 허용 필요
- 보안을 위해 VPN이나 private network 사용 권장

## Windows 자동 시작 설정 (Auto-start on Windows)

### 방법 1: Task Scheduler 이용

1. `Win + R` → `taskschd.msc` 입력 → Enter
2. "작업 만들기" 클릭
3. 일반 탭에서:
   - 이름: "EUM News Local Scraper"
   - "가장 높은 수준의 권한으로 실행" 체크
4. 트리거 탭에서:
   - 새 트리거 → "시작할 때"
5. 작업 탭에서:
   - 프로그램: `node`
   - 인수: `C:\path\to\local-scraper\lib\index.js`
   - 시작 위치: `C:\path\to\local-scraper`
6. 확인 클릭

### 방법 2: .bat 파일 이용

`start-scraper.bat` 파일 생성:

```batch
@echo off
cd C:\path\to\local-scraper
npm start
pause
```

그 후 바탕화면이나 시작 폴더에 바로가기 생성.

## 트러블슈팅 (Troubleshooting)

### Puppeteer Chrome 다운로드 실패
```bash
npm install puppeteer --save
```

### 포트 이미 사용 중
```bash
netstat -ano | findstr :3001
taskkill /PID <PID> /F
```

### 장비 인증 문제
- Windows PC에 HK_Device_Detector 설치 필수
- 마켓인사이트/더벨 정상 로그인 확인
- 로그인 후 Puppeteer 스크래핑 진행

## 보안 주의사항 (Security)

- 로컬 네트워크에서만 사용
- 공개 인터넷에 노출 금지
- 인증 정보(ID/PW)는 환경 변수로 관리
- HTTPS 사용 권장 (운영 환경)

## 개발 노트 (Development Notes)

### 로그 확인
서버 콘솔에서 상세 로그 확인 가능:
```
Local scraper server running on port 3001
Health check: http://localhost:3001/health
MarketInsight login: POST http://localhost:3001/api/marketinsight/login
```

### Puppeteer 옵션 커스터마이징

`src/services/marketInsightService.ts` 또는 `src/services/thebellService.ts`의 `args` 배열 수정:

```typescript
args: [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--headless=new',  // 추가
  '--disable-gpu',   // 추가
]
```

## 라이센스

ISC
