# 로컬 스크래퍼 설정 가이드 (Local Scraper Setup Guide)

## 개요 (Overview)

이 가이드는 Windows PC에서 로컬 스크래퍼 서버를 설정하고 실행하는 방법을 설명합니다.

**아키텍처:**
- **PC (Windows)**: Puppeteer 스크래퍼 서버 실행
- **Cloud Run**: PC 서버 호출하여 데이터 처리

---

## 1단계: 필수 소프트웨어 설치 (Step 1: Install Prerequisites)

### Node.js 설치
1. https://nodejs.org/ 방문
2. LTS 버전 다운로드 및 설치
3. 설치 후 명령 프롬프트에서 확인:
   ```bash
   node --version
   npm --version
   ```

### HK_Device_Detector 설치 (중요)
- **마켓인사이트**: https://www.marketinsight.co.kr 에서 제공
- **더벨**: https://www.thebell.co.kr 에서 제공

두 사이트 모두 장비 인증 프로그램을 설치해야 로그인 가능합니다.

---

## 2단계: 스크래퍼 서버 설정 (Step 2: Set Up Scraper Server)

### 디렉토리 네비게이션
```bash
cd path\to\eum_news\local-scraper
```

### 의존성 설치
```bash
npm install
```

또는 자동화 스크립트 실행:
```bash
setup.bat
```

---

## 3단계: 서버 실행 (Step 3: Start Server)

### 개발 모드
```bash
npm run dev
```

### 프로덕션 모드
```bash
npm start
```

또는 배치 파일 사용:
```bash
start.bat
```

**출력 예시:**
```
Local scraper server running on port 3001
Health check: http://localhost:3001/health
MarketInsight login: POST http://localhost:3001/api/marketinsight/login
MarketInsight scrape: GET http://localhost:3001/api/marketinsight/scrape
Thebell login: POST http://localhost:3001/api/thebell/login
Thebell scrape: GET http://localhost:3001/api/thebell/scrape
```

---

## 4단계: 서버 테스트 (Step 4: Test Server)

### Health Check
```bash
curl http://localhost:3001/health
```

예상 응답:
```json
{"status":"ok","timestamp":"2024-03-21T10:00:00.000Z"}
```

### 마켓인사이트 로그인 테스트
```bash
curl -X POST http://localhost:3001/api/marketinsight/login ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"your@email.com\",\"password\":\"your_password\"}"
```

### 마켓인사이트 기사 스크래핑 테스트
```bash
curl "http://localhost:3001/api/marketinsight/scrape?category=mna"
```

### 더벨 로그인 테스트
```bash
curl -X POST http://localhost:3001/api/thebell/login ^
  -H "Content-Type: application/json" ^
  -d "{\"email\":\"user_id\",\"password\":\"password\"}"
```

### 더벨 기사 스크래핑 테스트
```bash
curl "http://localhost:3001/api/thebell/scrape?category=news"
```

---

## 5단계: Windows 자동 시작 설정 (Step 5: Auto-Start on Windows Boot)

### 방법 A: Task Scheduler (권장)

1. `Win + R` → `taskschd.msc` 입력
2. "작업 만들기" 클릭
3. **일반** 탭:
   - 이름: `EUM News Local Scraper`
   - ✓ "가장 높은 수준의 권한으로 실행"
4. **트리거** 탭:
   - "새 트리거" → "시작할 때"
5. **작업** 탭:
   - 프로그램: `node`
   - 인수: `C:\full\path\to\local-scraper\lib\index.js`
   - 시작 위치: `C:\full\path\to\local-scraper`
6. OK 클릭

### 방법 B: 시작 폴더 바로가기

1. `start.bat` 바로가기 생성
2. `Win + R` → `shell:startup` 입력
3. 바로가기를 시작 폴더에 복사

---

## 6단계: Cloud Run 통합 (Step 6: Cloud Run Integration)

로컬 서버가 실행 중일 때, Cloud Run 함수는 다음과 같이 호출할 수 있습니다:

### 예시 (Node.js)
```typescript
const localScraperUrl = 'http://YOUR_PC_IP:3001';

// 마켓인사이트 로그인
const loginResponse = await fetch(`${localScraperUrl}/api/marketinsight/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: process.env.MARKETINSIGHT_EMAIL,
    password: process.env.MARKETINSIGHT_PASSWORD,
  }),
});

// 기사 스크래핑
const scrapeResponse = await fetch(
  `${localScraperUrl}/api/marketinsight/scrape?category=mna`
);
const articles = await scrapeResponse.json();
```

### PC IP 주소 확인
```bash
ipconfig
```

`IPv4 주소` 값 사용 (예: 192.168.1.100)

---

## 7단계: 방화벽 설정 (Step 7: Firewall Configuration)

Windows Defender 방화벽에서 포트 3001 허용:

1. "Windows Defender 방화벽" 검색
2. "앱이 방화벽을 통과하도록 허용" 클릭
3. "다른 앱 허용" → "찾아보기" → node.exe 선택
4. "추가" 클릭
5. 포트 3001이 허용되는지 확인

---

## 보안 고려사항 (Security)

⚠️ **중요:**
- 로컬 네트워크에서만 사용
- 인증 정보(ID/PW)는 절대 코드에 하드코딩 금지
- 환경 변수 또는 보안 저장소 사용
- 공개 인터넷 노출 금지

---

## 트러블슈팅 (Troubleshooting)

### "포트 3001은 이미 사용 중입니다"
```bash
netstat -ano | findstr :3001
taskkill /PID <PID> /F
```

### "Node.js를 찾을 수 없습니다"
- Node.js 설치 확인
- 경로 환경 변수 재설정 (재부팅 필요)

### "Puppeteer Chrome 다운로드 실패"
```bash
npm install puppeteer --force
```

### "로그인 실패"
1. PC에서 마켓인사이트/더벨 직접 로그인 확인
2. HK_Device_Detector 설치 확인
3. 브라우저 캐시 삭제 후 재시도

### "로컬 서버 호출 실패 (Cloud Run에서)"
- 로컬 PC가 켜져 있는지 확인
- 서버 실행 중인지 확인: `curl http://localhost:3001/health`
- PC 방화벽 포트 3001 허용 확인
- Cloud Run에서 사용할 IP 주소 확인 (ipconfig)

---

## 다음 단계 (Next Steps)

1. ✅ 로컬 스크래퍼 서버 실행
2. ✅ Windows 자동 시작 설정
3. ⬜ Cloud Run 함수 업데이트 (PC 호출 로직 추가)
4. ⬜ 환경 변수 설정 (이메일, 비밀번호)
5. ⬜ 전체 시스템 테스트

---

## 문의 사항

스크래퍼 서버 상세 정보: `/local-scraper/README.md` 참조
