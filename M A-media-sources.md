# M&A 기사 수집 매체 가이드

> **목적**: M&A 관련 기사를 자동 수집하기 위한 매체별 RSS/API/스크래핑 정보 정리
>
> **마지막 업데이트**: 2026-03-20
>
> **사용 방법**: 에이전트는 이 문서를 참조하여 각 매체에서 기사를 수집

---

## 📊 매체 현황 요약

| 구분 | 개수 | 주요 매체 |
|------|------|----------|
| **RSS 무료** | 13개 | 한국경제, 매일경제, DealStreetAsia 등 |
| **API 유료** | 5개 | Reuters, Bloomberg, PitchBook 등 |
| **스크래핑 필요** | 4개 | 더벨, 오투저널 등 |
| **뉴스레터** | 3개 | Axios, Morning Brew, Term Sheet |

---

## ✅ Part 1: RSS 무료 제공 매체

### 한국어 매체

#### 1.1 한국경제신문
```yaml
이름: 한국경제신문
URL: https://www.hankyung.com
RSS: https://www.hankyung.com/rss
언어: 한국어
카테고리: 전체 경제 (M&A 포함)
업데이트: 실시간
특징:
  - 국내 주요 경제 매체
  - M&A 전담 기자 보유
  - RSS 모든 섹션 제공
M&A 관련성: ★★★★☆
사용 방법:
  - RSS 피드에서 M&A 키워드 필터링
  - "인수", "합병", "M&A", "피인수" 등 키워드 검색
```

#### 1.2 매일경제
```yaml
이름: 매일경제
URL: https://www.mk.co.kr
RSS: https://www.mk.co.kr/rss
언어: 한국어
카테고리: 전체 경제
업데이트: 실시간
특징:
  - 경제 섹션별 RSS 분리
  - M&A 관련 기사 다수
M&A 관련성: ★★★★☆
사용 방법:
  - RSS 피드 구독
  - 키워드: "M&A", "인수합병", "피인수", "지분인수"
```

#### 1.3 파이낸셜뉴스
```yaml
이름: 파이낸셜뉴스
URL: https://www.fnnews.com
RSS: https://www.fnnews.com/rss
언어: 한국어
카테고리: 금융/경제
업데이트: 실시간
특징:
  - 금융 중심
  - PE/VC 기사 많음
M&A 관련성: ★★★☆☆
사용 방법:
  - RSS 구독 후 금융/PE 섹션 필터
```

#### 1.4 이데일리
```yaml
이름: 이데일리
URL: https://www.edaily.co.kr
RSS: https://www.edaily.co.kr/rss
언어: 한국어
카테고리: 경제 전반
업데이트: 실시간
M&A 관련성: ★★★☆☆
```

#### 1.5 서울경제
```yaml
이름: 서울경제
URL: https://www.sedaily.com
RSS: https://www.sedaily.com/rss
언어: 한국어
카테고리: 경제
특징:
  - 머니타워 M&A 섹션
M&A 관련성: ★★★☆☆
```

#### 1.6 헤럴드경제
```yaml
이름: 헤럴드경제
URL: https://news.heraldcorp.com
RSS: https://news.heraldcorp.com/rss
언어: 한국어
카테고리: 경제
M&A 관련성: ★★★☆☆
```

#### 1.7 아시아경제
```yaml
이름: 아시아경제
URL: https://www.asiae.co.kr
RSS: https://www.asiae.co.kr/rss
언어: 한국어
카테고리: 경제
M&A 관련성: ★★★☆☆
```

#### 1.8 머니투데이
```yaml
이름: 머니투데이
URL: https://www.mt.co.kr
RSS: https://www.mt.co.kr/rss
언어: 한국어
카테고리: 경제/금융
M&A 관련성: ★★★☆☆
```

#### 1.9 연합뉴스
```yaml
이름: 연합뉴스
URL: https://www.yna.co.kr
RSS: https://www.yna.co.kr/rss
언어: 한국어
카테고리: 종합 뉴스
특징:
  - 뉴스와이어 포함
  - M&A 공식 발표 빠름
M&A 관련성: ★★★★☆ (뉴스와이어)
```

#### 1.10 The Korea Herald
```yaml
이름: The Korea Herald
URL: http://www.koreaherald.com
RSS: http://www.koreaherald.com/rss
언어: 영어
카테고리: 비즈니스
특징:
  - 한국 경제 뉴스 (영어)
  - 크로스보더 M&A
M&A 관련성: ★★★☆☆
```

### 영어 매체

#### 1.11 DealStreetAsia
```yaml
이름: DealStreetAsia
URL: https://dealstreetasia.com
RSS: https://dealstreetasia.com/rss
언어: 영어
카테고리: 아시아 M&A 전문
업데이트: 일일
특징:
  - 아시아 M&A 전문 1위
  - PE/VC/크로스보더 딜
  - 딜 사이즈, 투자사 정보 상세
M&A 관련성: ★★★★★ (필수)
사용 방법:
  - RSS 구독 (무료)
  - 뉴스레터 구독 (일일 요약)
```

#### 1.12 Financial Times
```yaml
이름: Financial Times
URL: https://www.ft.com
RSS: https://www.ft.com/rss
언어: 영어
카테고리: 글로벌 비즈니스
업데이트: 실시간
특징:
  - 글로벌 M&A 트렌드
  - M&M (Mergers & Markets) 섹션
M&A 관련성: ★★★★★ (글로벌)
제한:
  - 일부 기사 유료 구독 필요
```

#### 1.13 MarketWatch
```yaml
이름: MarketWatch
URL: https://www.marketwatch.com
RSS: https://www.marketwatch.com/rss
언어: 영어
카테고리: 미국 시장/M&A
업데이트: 실시간
M&A 관련성: ★★★☆☆
```

#### 1.14 TechCrunch
```yaml
이름: TechCrunch
URL: https://techcrunch.com
RSS: https://techcrunch.com/feed
언어: 영어
카테고리: 테크 M&A
업데이트: 일일
특징:
  - Term Sheet 뉴스레터 (테크 M&A 일일)
  - 스타트업 인수합병
M&A 관련성: ★★★★★ (테크)
사용 방법:
  - RSS: techcrunch.com/feed
  - 뉴스레터: Term Sheet 구독
```

---

## 🔌 Part 2: API 제공 매체

### 2.1 Reuters
```yaml
이름: Reuters
API: Reuters Content API
URL: https://www.reuters.com/developers
언어: 영어
카테고리: 글로벌 뉴스
비용: 유료 (문의 필요)
특징:
  - 글로벌 M&A 실시간
  - 딜 뉴스 신속
  - API 형태 정형
M&A 관련성: ★★★★★ (글로벌)
사용 방법:
  1. 개발자 등록: https://www.reuters.com/developers
  2. API 키 발급
  3. /deals 엔드포인트 호출
제한:
  - 유료 (가격 문의 필요)
  - Rate limit 적용
```

### 2.2 Bloomberg
```yaml
이름: Bloomberg
API: Bloomberg API
URL: https://www.bloomberg.com/professional
언어: 영어
카테고리: 글로벌 금융/M&A
비용: 고가 (월 $X,XXX~)
특징:
  - 글로벌 M&A 데이터베이스
  - 딜 사이즈, 밸류에이션
  - 실시간 알림
M&A 관련성: ★★★★★ (프로)
제한:
  - 매우 고가
  - 기업용 라이선스
```

### 2.3 PitchBook
```yaml
이름: PitchBook
API: PitchBook API
URL: https://pitchbook.com
언어: 영어
카테고리: PE/VC/M&A 데이터
비용: 유료 (월 $XXX~)
특징:
  - PE/VC/M&A 딜 데이터
  - 밸류에이션, 투자사 정보
  - API로 추출 가능
M&A 관련성: ★★★★★ (데이터)
사용 방법:
  - 계약 후 API 접근 권한 부여
```

### 2.4 Mergermarket
```yaml
이름: Mergermarket
API: Mergermarket API
URL: https://www.mergermarket.com
언어: 영어
카테고리: M&A 인텔리전스
비용: 유료
특징:
  - M&A 전문 리서치
  - 딜 rumors, pipeline
M&A 관련성: ★★★★★ (전문)
```

### 2.5 NewsAPI (무료 티어)
```yaml
이름: NewsAPI
API: https://newsapi.org
언어: 다국어
카테고리: 비즈니스 뉴스 어그리게이터
비용: 무료 (일일 제한)
특징:
  - 전 세계 비즈니스 뉴스
  - M&A 키워드 검색
M&A 관련성: ★★★☆☆
사용 방법:
  - 무료 API 키 발급
  - /everything?q=M&A+OR+merger+OR+acquisition
제한:
  - 무료 티어: 일일 100회 요청
  - 상용 사용 불가
```

---

## ❌ Part 3: 스크래핑 필요 매체

### 3.1 더벨 (The Bell)
```yaml
이름: 더벨
URL: https://www.thebell.co.kr
언어: 한국어
카테고리: 자본시장/M&A 전문
수집 방법: 웹 스크래핑
특징:
  - 국내 M&A 전문 1위
  - PE/VC 딜 상세
  - 심층 리포트
M&A 관련성: ★★★★★ (국내 전문)
스크래핑 방법:
  1. M&A 섹션 URL: https://www.thebell.co.kr/free/content/MA
  2. 기사 리스트 페이지 크롤링
  3. 각 기사 상세 페이지 접근
  4. 제목, 본문, 날짜 추출
주의사항:
  - robots.txt 확인
  - 과도한 요청 피하기 (초당 1회 이하)
  - User-Agent 설정
```

### 3.2 오투저널 (OtoJournal)
```yaml
이름: 오투저널
URL: https://www.otojournal.com
언어: 한국어
카테고리: 벤처캐피털/M&A
수집 방법: 웹 스크래핑
특징:
  - 벤처캐피털 전문
  - 스타트업 M&A
M&A 관련성: ★★★★☆ (벤처)
스크래핑 방법:
  - 사이트 구조 분석 필요
  - RSS 미제공
```

### 3.3 내외경제신문
```yaml
이름: 내외경제신문
URL: http://www.nnaews.co.kr
언어: 한국어
카테고리: 경제
수집 방법: 웹 스크래핑
M&A 관련성: ★★★☆☆
```

### 3.4 Nikkei Asia
```yaml
이름: Nikkei Asia
URL: https://asia.nikkei.com
언어: 영어
카테고리: 아시아 비즈니스/M&A
수집 방법: 유료 구독 필요
비용: 월 $XX
특징:
  - 아시아 크로스보더 M&A
  - 일본/중국/동남아 딜
M&A 관련성: ★★★★★ (아시아)
제한:
  - 유료 구독
  - API 없음
```

---

## 📧 Part 4: 뉴스레터 (심층 인사이트)

### 4.1 Axios Markets
```yaml
이름: Axios Markets
URL: https://www.axios.com/newsletters/axios-markets
형태: 이메일 뉴스레터
빈도: 매일 아침
특징:
  - M&A 브리핑
  - 딜 시장 인사이트
M&A 관련성: ★★★★☆
수집 방법:
  - 이메일 구독
  - 이메일 파싱 (자동화 가능)
```

### 4.2 Morning Brew
```yaml
이름: Morning Brew
URL: https://www.morningbrew.com
형태: 이메일 뉴스레터
빈도: 매일 아침
특징:
  - 비즈니스 뉴스 요약
  - M&A 간단 언급
M&A 관련성: ★★★☆☆
```

### 4.3 Term Sheet (TechCrunch)
```yaml
이름: Term Sheet
URL: https://techcrunch.com/tag/term-sheet
형태: 뉴스레터 + 웹
빈도: 매일
특징:
  - 테크 M&A 전문
  - 스타트업 인수합병
M&A 관련성: ★★★★★ (테크)
수집 방법:
  - 뉴스레터 구독
  - 웹 태그 모니터링
```

---

## 🎯 Part 5: 수집 전략 추천

### Phase 1: 무료 시작 (즉시 가능)
```yaml
RSS 구독 목록:
  - 한국경제 RSS
  - 매일경제 RSS
  - DealStreetAsia RSS
  - TechCrunch RSS
예상 커버리지: 국내 70%, 아시아 60%
비용: 무료
구현 시간: 1시간 이내
```

### Phase 2: 스크래핑 추가 (1-2일)
```yaml
스크래핑 대상:
  - 더벨 M&A 섹션
  - 오투저널
추가 커버리지: 국내 M&A 전문 +20%
비용: 개발 비용
구현 시간: 1-2일
주의: robots.txt, rate limiting
```

### Phase 3: API 도입 (1주 이상)
```yaml
API 도입:
  - DealStreetAsia API (아시아)
  - Reuters API (글로벌) 또는
  - NewsAPI 무료 티어 (테스트)
추가 커버리지: 글로벌 +30%
비용: 월 $XXX ~ $X,XXX
구현 시간: 1주 (계약, 개발)
```

---

## 🛠️ Part 6: 에이전트 구현 가이드

### RSS 파싱
```python
# 의사코드
import feedparser

def fetch_rss(url):
    feed = feedparser.parse(url)
    articles = []
    for entry in feed.entries:
        article = {
            'title': entry.title,
            'link': entry.link,
            'published': entry.get('published'),
            'summary': entry.get('summary', ''),
            'source': url
        }
        articles.append(article)
    return articles

# M&A 필터링
ma_keywords = ['M&A', '인수', '합병', '피인수', 'merger', 'acquisition']
def is_ma_related(article):
    text = f"{article['title']} {article['summary']}".lower()
    return any(keyword.lower() in text for keyword in ma_keywords)
```

### 스크래핑
```python
# 의사코드
import requests
from bs4 import BeautifulSoup
import time

def scrape_thebell():
    url = "https://www.thebell.co.kr/free/content/MA"
    headers = {'User-Agent': 'Mozilla/5.0'}
    response = requests.get(url, headers=headers)
    soup = BeautifulSoup(response.content, 'html.parser')
    # 기사 리스트 추출 로직
    articles = []
    for item in soup.select('.article-item'):
        article = {
            'title': item.select_one('.title').text,
            'link': item.select_one('a')['href'],
            'date': item.select_one('.date').text
        }
        articles.append(article)
    time.sleep(1)  # Rate limiting
    return articles
```

### API 호출
```python
# NewsAPI 예시
import requests

def fetch_newsapi_ma():
    url = "https://newsapi.org/v2/everything"
    params = {
        'q': 'M&A OR merger OR acquisition',
        'language': 'en',
        'sortBy': 'publishedAt',
        'apiKey': 'YOUR_API_KEY'
    }
    response = requests.get(url, params=params)
    return response.json()['articles']
```

---

## 📊 Part 7: 우선순위 매핑

### M&A 관련성별 우선순위
1. **★★★★★ (필수)**
   - 더벨 (국내 M&A 전문 1위)
   - DealStreetAsia (아시아 M&A 전문)
   - Term Sheet (테크 M&A)
   - Financial Times (글로벌)

2. **★★★★☆ (중요)**
   - 한국경제
   - 매일경제
   - 연합뉴스 (뉴스와이어)
   - Reuters API

3. **★★★☆☆ (참고)**
   - 파이낸셜뉴스
   - 이데일리
   - 서울경제
   - MarketWatch

### 비용/효율별 우선순위
1. **무료 + 고효율**
   - 한국경제 RSS
   - 매일경제 RSS
   - DealStreetAsia RSS

2. **유료 + 최고효율**
   - Reuters API
   - PitchBook API

3. **개발 필요 + 중간효율**
   - 더벨 스크래핑
   - 오투저널 스크래핑

---

## ⚠️ Part 8: 법적/기술적 주의사항

### robots.txt 확인
```bash
# 각 사이트의 robots.txt 확인 필수
curl https://www.thebell.co.kr/robots.txt
curl https://dealstreetasia.com/robots.txt
```

### Rate Limiting
- RSS: 요청 제한 없음 (일반적으로)
- 스크래핑: 초당 1회 이하 권장
- API: 각 API별 rate limit 준수

### User-Agent
```python
headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; M&A-Bot/1.0; +https://yourdomain.com/bot)'
}
```

### 이용약관
- 상용 사용 시 각 매체 이용약책 확인
- 유료 API는 라이선스 준수
- 스크래핑은 법적 리스크 고려

---

## 📝 Part 9: 모니터링 로그

### 업데이트 내역
- **2026-03-20**: 초기 버전 생성, 25개 매체 분석
- **추가 필요**: 실제 RSS 동작 테스트, 스크래핑 테스트

### TODO
- [ ] 각 RSS 실제 동작 테스트
- [ ] 스크래핑 프로토타입 개발
- [ ] API 무료 티어 테스트
- [ ] 수집 파이프라인 구축
- [ ] M&A 키워드 필터링 최적화

---

## 📞 문의

이 문서에 대한 업데이트나 수정이 필요하면:
- 대표님께 문의
- 또는 새로운 매체 발견 시 추가

---

**끝**
