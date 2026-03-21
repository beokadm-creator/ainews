# AI News Local Scraper - PC 부팅 시 자동 실행 가이드

## 📋 전체 경로 정리

```
C:\Users\whhol\ainews\ainews\local-scraper\
├── 배치 파일들
│   ├── setup-windows-autostart.bat      ← [최초 1회] 자동 시작 설정
│   ├── start.bat                        ← [수동] 서버 수동 시작
│   ├── start-chrome.bat                 ← [수동] Chrome 원격 디버깅 시작
│   ├── start-chrome-background.bat      ← [자동] Chrome 백그라운드 실행 (Windows 자동 실행)
│   ├── stop.bat                         ← [수동] 서버 정지
│   └── verify-setup.bat                 ← [확인] 설정 상태 점검
│
├── 핵심 파일들
│   ├── package.json
│   ├── tsconfig.json
│   ├── ecosystem.config.js              ← PM2 설정 파일
│   └── src/                             ← 소스 코드
│
├── logs/                                ← 로그 폴더 (자동 생성)
├── lib/                                 ← 컴파일된 JavaScript (자동 생성)
└── node_modules/                        ← 의존성 (npm install로 생성)

Windows 시작 프로그램 폴더:
C:\Users\whhol\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\
└── chrome-remote-debug.bat              ← Chrome 자동 실행 바로가기 (자동 등록)
```

---

## 🚀 최초 설정 (최초 1회만 필요)

### 1단계: 관리자 권한으로 PowerShell 실행
```powershell
cd C:\Users\whhol\ainews\ainews\local-scraper
```

### 2단계: 자동 시작 설정 실행
```powershell
.\setup-windows-autostart.bat
```

**이 배치 파일이 수행하는 작업:**
- ✅ npm 의존성 설치
- ✅ TypeScript 빌드
- ✅ PM2 글로벌 설치
- ✅ PM2에 로컬 스크래퍼 등록
- ✅ Windows 시작 프로그램에 Chrome 등록

---

## 🔄 PC 부팅 후 자동 실행 순서

### 부팅 시 자동 실행 (사용자 개입 없음)
1. **Chrome 원격 디버깅 포트 (9222) 자동 실행**
   - 파일: `C:\Users\whhol\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\chrome-remote-debug.bat`
   - 역할: 보안 검증된 Chrome 브라우저 제공
   - 로그인 상태: 자동으로 더벨/마켓인사이트 로그인 상태 유지

2. **로컬 스크래퍼 서버 자동 시작 (포트 3001)**
   - 도구: PM2 (Node.js 프로세스 매니저)
   - 역할: 마켓인사이트/더벨 스크래핑 API 제공
   - 상태: `pm2 status`로 확인

---

## 📍 주요 경로 정보

| 항목 | 경로 |
|------|------|
| **로컬 스크래퍼 폴더** | `C:\Users\whhol\ainews\ainews\local-scraper` |
| **배치 파일들** | `C:\Users\whhol\ainews\ainews\local-scraper\*.bat` |
| **로그 폴더** | `C:\Users\whhol\ainews\ainews\local-scraper\logs` |
| **Chrome 설정** | `C:\Users\whhol\AppData\Local\Google\Chrome\User Data` |
| **Chrome 시작 프로그램** | `C:\Users\whhol\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup` |
| **마켓인사이트 로그인** | https://marketinsight.hankyung.com/ |
| **더벨 로그인** | https://www.thebell.co.kr/LoginCert/Login.asp |

---

## 🔧 수동 사용 명령어

### Chrome 수동 실행 (테스트 목적)
```powershell
.\start-chrome.bat
```

### 로컬 스크래퍼 수동 실행
```powershell
.\start.bat
```

### 로컬 스크래퍼 정지
```powershell
.\stop.bat
```

### 서버 상태 확인
```powershell
pm2 status
pm2 logs ainews-local-scraper
```

---

## ✅ 설정 상태 점검

부팅 후 모든 서비스가 정상 실행되는지 확인:

```powershell
.\verify-setup.bat
```

**확인 항목:**
- ✓ Chrome 포트 9222 정상
- ✓ 로컬 스크래퍼 헬스 체크
- ✓ PM2 상태
- ✓ 로그 폴더
- ✓ Windows 시작 프로그램 등록

---

## 🌐 서비스 엔드포인트

PC 부팅 후 자동으로 실행되면 다음 경로 사용 가능:

```
# 마켓인사이트 로그인
POST http://localhost:3001/api/marketinsight/login
Body: { "email": "eumpe123", "password": "eumpe123" }

# 마켓인사이트 스크래핑
GET http://localhost:3001/api/marketinsight/scrape?category=mna

# 더벨 로그인
POST http://localhost:3001/api/thebell/login
Body: { "email": "eumpe123", "password": "eumpe123" }

# 더벨 스크래핑
GET http://localhost:3001/api/thebell/scrape?category=news

# 헬스 체크
GET http://localhost:3001/health
```

---

## 🛠️ 트러블슈팅

### Chrome 자동 실행이 안 됨
1. Windows 시작 프로그램 폴더 확인:
   ```
   C:\Users\whhol\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
   ```
2. `chrome-remote-debug.bat` 파일 존재 확인
3. 없으면 수동으로 복사:
   ```powershell
   copy "C:\Users\whhol\ainews\ainews\local-scraper\start-chrome-background.bat" `
        "C:\Users\whhol\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\chrome-remote-debug.bat"
   ```

### 로컬 스크래퍼 자동 실행이 안 됨
```powershell
pm2 status              # 상태 확인
pm2 logs ainews-local-scraper   # 로그 확인
pm2 resurrect           # PM2 프로세스 복구
```

### 포트 충돌
```powershell
# 포트 3001이 사용 중인지 확인
netstat -ano | findstr :3001

# 사용 중인 프로세스 종료 (필요시)
taskkill /PID <PID> /F
```

---

## 📝 마지막 체크리스트

- [ ] `setup-windows-autostart.bat` 실행 완료
- [ ] `verify-setup.bat`에서 모든 항목 ✓ 확인
- [ ] PC 재부팅 후 서비스 정상 작동 확인
- [ ] Chrome 포트 9222 접근 가능
- [ ] 로컬 스크래퍼 포트 3001 접근 가능
- [ ] 마켓인사이트 로그인 성공
- [ ] 더벨 로그인 성공
