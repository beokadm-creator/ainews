import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser } from 'puppeteer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const COOKIES_FILE = path.join(__dirname, '../../cookies/thebell.json');

export interface Article {
  title: string;
  link: string;
  date: string;
  isPaid: boolean;
  category?: string;
  summary?: string;
}

export interface ScrapingResult {
  success: boolean;
  data?: Article[];
  error?: string;
}

const DEAL_KEYWORDS = [
  '인수', '매각', '매물', '투자', '집행', '지분투자', '경영권',
  '인수금융', '바이아웃', '공동투자', 'EXIT', '엑시트', '회수',
  'IPO', '상장', '블록딜', 'M&A', '합병', '분할', '매수', '펀드',
];

function matchesKeyword(text: string): boolean {
  return DEAL_KEYWORDS.some(kw => text.includes(kw));
}

export class ThebellService {
  private browser: Browser | null = null;
  private isConnectedToChrome: boolean = false;

  async init(): Promise<void> {
    if (this.browser) return;

    try {
      console.log('[Thebell] Trying to connect to Chrome remote debugging port 9222...');
      const response = await axios.get('http://localhost:9222/json/version', { timeout: 2000 });
      const wsUrl = response.data.webSocketDebuggerUrl;
      this.browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null,
        protocolTimeout: 180000,
      }) as unknown as Browser;
      this.isConnectedToChrome = true;
      console.log('[Thebell] Connected to existing Chrome instance!');
    } catch {
      console.log('[Thebell] Chrome not available, launching headless browser...');
      this.browser = await puppeteer.launch({
        headless: true,
        protocolTimeout: 180000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      this.isConnectedToChrome = false;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      if (this.isConnectedToChrome) {
        await (this.browser as any).disconnect();
      } else {
        await this.browser.close();
      }
      this.browser = null;
    }
  }

  private loadCookies(): any[] {
    try {
      if (fs.existsSync(COOKIES_FILE)) {
        const data = fs.readFileSync(COOKIES_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {
      console.log('[Thebell] No saved cookies found');
    }
    return [];
  }

  private saveCookies(cookies: any[]): void {
    try {
      const dir = path.dirname(COOKIES_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
      console.log('[Thebell] Cookies saved!');
    } catch (e) {
      console.error('[Thebell] Failed to save cookies:', e);
    }
  }

  async login(id: string, password: string): Promise<boolean> {
    if (!this.browser) await this.init();

    const page = await this.browser!.newPage();
    try {
      // 1. 저장된 쿠키 로드
      const savedCookies = this.loadCookies();
      if (savedCookies.length > 0) {
        console.log('[Thebell] Loading saved cookies...');
        await page.setCookie(...savedCookies);
      }

      // 2. 홈페이지로 이동해서 로그인 상태 확인
      console.log('[Thebell] Checking login status...');
      await page.goto('https://www.thebell.co.kr/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      const currentUrl = page.url();
      const isLoggedIn = !currentUrl.includes('Login.asp') &&
        await page.$('[class*="logout"], .user-menu, [class*="user-profile"]').then(el => !!el).catch(() => false);

      if (isLoggedIn) {
        console.log('[Thebell] Already logged in via cookies!');
        const cookies = await page.cookies();
        this.saveCookies(cookies);
        return true;
      }

      // 3. 로그인 페이지로 이동
      console.log('[Thebell] Loading login page...');
      await page.goto('https://www.thebell.co.kr/LoginCert/Login.asp', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      // 4. ID/PW 입력
      await page.waitForSelector('#id', { timeout: 10000 });
      await page.type('#id', id);
      await page.waitForSelector('#pw', { timeout: 10000 });
      await page.type('#pw', password);

      console.log('[Thebell] Submitting login...');
      await page.keyboard.press('Enter');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 3000));

      const afterUrl = page.url();
      if (!afterUrl.includes('Login.asp')) {
        const cookies = await page.cookies();
        this.saveCookies(cookies);
        console.log('[Thebell] Login successful! Cookies saved.');
        return true;
      }

      console.log('[Thebell] Login failed');
      return false;
    } catch (error) {
      console.error('[Thebell] Login error:', error);
      return false;
    } finally {
      await page.close();
    }
  }

  // ─── 마이페이지 키워드 뉴스 (모든 페이지) ───────────────────────────
  async scrapeKeywordNews(maxPages: number = 50): Promise<ScrapingResult> {
    if (!this.browser) await this.init();

    const allArticles: any[] = [];
    const seen = new Set<string>();

    try {
      const savedCookies = this.loadCookies();
      let loginSuccess = false;

      // 기존 쿠키로 시도
      if (savedCookies.length > 0) {
        const page = await this.browser!.newPage();
        try {
          await page.setCookie(...savedCookies);
          await page.goto('https://www.thebell.co.kr/Member/MyKeywordNews.asp?mbrmenu=02', {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
          });
          const currentUrl = page.url();
          loginSuccess = !currentUrl.includes('Login.asp');
        } finally {
          await page.close();
        }
      }

      if (!loginSuccess) {
        return { success: false, error: 'Not logged in - please login to MyKeywordNews first' };
      }

      // 모든 페이지 순회
      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const page = await this.browser!.newPage();
        try {
          if (savedCookies.length > 0) {
            await page.setCookie(...savedCookies);
          }

          const url = `https://www.thebell.co.kr/Member/MyKeywordNews.asp?mbrmenu=02&page=${pageNum}`;
          console.log(`[Thebell] Scraping keyword news page ${pageNum}: ${url}`);

          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000)); // 자연스러운 로딩

          const pageArticles = await page.evaluate(() => {
            const items: any[] = [];

            // .newsList.tp1 > ul > li 구조
            document.querySelectorAll('.newsList.tp1 ul li').forEach((li: Element) => {
              const titleEl = li.querySelector('dl dt a') as HTMLAnchorElement;
              const summaryEl = li.querySelector('dl dd a');
              const dateEl = li.querySelector('.userBox .date');

              if (titleEl && titleEl.href) {
                items.push({
                  title: titleEl.textContent?.trim() || '',
                  link: titleEl.href,
                  date: dateEl?.textContent?.trim() || new Date().toISOString().split('T')[0],
                  isPaid: true, // 키워드 뉴스는 대부분 유료
                  summary: summaryEl?.textContent?.trim() || '',
                  category: 'keyword',
                });
              }
            });

            return items;
          });

          if (pageArticles.length === 0) {
            console.log(`[Thebell] No articles on page ${pageNum} — stopping`);
            break;
          }

          // 중복 제거
          pageArticles.forEach((a: any) => {
            if (!seen.has(a.link)) {
              seen.add(a.link);
              allArticles.push(a);
            }
          });

          console.log(`[Thebell] Page ${pageNum}: ${pageArticles.length} articles (${allArticles.length} total)`);
          await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000)); // 페이지 간 대기
        } catch (error: any) {
          console.warn(`[Thebell] Page ${pageNum} failed:`, error.message);
          if (pageNum === 1) throw error; // 첫 페이지 실패는 치명적
          break;
        } finally {
          await page.close();
        }
      }

      console.log(`[Thebell] Total keyword news articles: ${allArticles.length}`);
      return { success: true, data: allArticles };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ─── 메인 페이지 기사 (구 로직, 호환성 유지) ─────────────────────────
  async scrapeArticles(category: string = 'deal', filterKeywords: boolean = true): Promise<ScrapingResult> {
    if (!this.browser) await this.init();

    const page = await this.browser!.newPage();
    try {
      const savedCookies = this.loadCookies();
      if (savedCookies.length > 0) {
        await page.setCookie(...savedCookies);
      }

      // deal 페이지 (Code=01)
      const url = `https://www.thebell.co.kr/front/NewsMain.asp?Code=01`;
      console.log(`[Thebell] Scraping main: ${url}`);
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      const currentUrl = page.url();
      if (currentUrl.includes('Login.asp') || currentUrl.includes('login')) {
        return { success: false, error: 'Not logged in - please login first' };
      }

      const articles = await page.evaluate(() => {
        const items: any[] = [];
        const seen = new Set<string>();

        // 1. 메인 스토리 박스 (.topStorisBox .storiView ul li)
        document.querySelectorAll('.topStorisBox .storiView ul li').forEach((li: Element) => {
          const titleEl = li.querySelector('dl dt p a.txtE') as HTMLAnchorElement;
          const summaryEl = li.querySelector('dl dd a');
          const hasFreeIcon = !!li.querySelector('.clsclock');
          const hasFreeTime = !!li.querySelector('.freeTimeText');

          if (titleEl && titleEl.href && !seen.has(titleEl.href)) {
            seen.add(titleEl.href);
            items.push({
              title: titleEl.textContent?.trim() || '',
              link: titleEl.href,
              date: new Date().toISOString().split('T')[0],
              isPaid: !hasFreeIcon && !hasFreeTime,
              summary: summaryEl?.textContent?.trim() || '',
              category: 'deal',
            });
          }
        });

        // 2. 섹션별 기사 목록 (.pointNewBox)
        document.querySelectorAll('.pointNewBox > ul > li').forEach((section: Element) => {
          const sectionTitle = section.querySelector('.titBox .tit')?.textContent?.trim() || '';

          // 메인 기사
          const mainEl = section.querySelector('.newsList dt p a.txtE') as HTMLAnchorElement;
          if (mainEl && mainEl.href && !seen.has(mainEl.href)) {
            seen.add(mainEl.href);
            const hasFree = !!section.querySelector('.newsList dt .clsclock');
            items.push({
              title: mainEl.textContent?.trim() || '',
              link: mainEl.href,
              date: new Date().toISOString().split('T')[0],
              isPaid: !hasFree,
              category: sectionTitle,
            });
          }

          // 부기사 목록
          section.querySelectorAll('.linkList ul li a.txtE').forEach((a: Element) => {
            const anchor = a as HTMLAnchorElement;
            if (anchor.href && !seen.has(anchor.href)) {
              seen.add(anchor.href);
              const hasFree = !!anchor.closest('li')?.querySelector('.clsclock');
              items.push({
                title: anchor.textContent?.trim() || '',
                link: anchor.href,
                date: new Date().toISOString().split('T')[0],
                isPaid: !hasFree,
                category: sectionTitle,
              });
            }
          });
        });

        return items;
      });

      // 키워드 필터링
      const filtered = filterKeywords
        ? articles.filter((a: any) => matchesKeyword(a.title) || matchesKeyword(a.summary || ''))
        : articles;

      console.log(`[Thebell] Scraped ${articles.length} articles, ${filtered.length} after keyword filter`);
      return { success: true, data: filtered };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      await page.close();
    }
  }

  // 기사 상세 내용 스크래핑
  async scrapeArticleDetail(url: string): Promise<{ title: string; subtitle: string; author: string; date: string; content: string } | null> {
    if (!this.browser) await this.init();

    const page = await this.browser!.newPage();
    try {
      const savedCookies = this.loadCookies();
      if (savedCookies.length > 0) await page.setCookie(...savedCookies);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // 사람처럼: 페이지 로드 후 짧은 대기 + 스크롤 시뮬레이션
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));
      await page.evaluate(async () => {
        const h = document.body.scrollHeight;
        const steps = 4;
        for (let i = 1; i <= steps; i++) {
          window.scrollTo(0, (h * i) / steps);
          await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
        }
      });
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));

      const detail = await page.evaluate(() => {
        // 제목
        const titleEl = document.querySelector('.viewHead .tit');
        const title = titleEl?.childNodes[0]?.textContent?.trim() || '';
        const subtitle = titleEl?.querySelector('em')?.textContent?.trim() || '';

        // 기자, 날짜
        const author = document.querySelector('.viewHead .user')?.textContent?.trim() || '';
        const date = document.querySelector('.viewHead .date')?.textContent?.trim() || '';

        // 본문 (광고 제거)
        const articleMain = document.querySelector('#article_main');
        if (articleMain) {
          // 광고 제거
          articleMain.querySelectorAll('.article_content_banner, script, img.ADVIMG').forEach(el => el.remove());
          const content = articleMain.textContent?.trim().replace(/\s+/g, ' ') || '';
          return { title, subtitle, author, date, content };
        }
        return null;
      });

      return detail;
    } catch (error) {
      console.error('[Thebell] Article detail error:', error);
      return null;
    } finally {
      await page.close();
    }
  }

  // 현재 Chrome 세션에서 쿠키 추출해서 저장
  async saveCookiesFromChrome(): Promise<boolean> {
    if (!this.browser) await this.init();

    const page = await this.browser!.newPage();
    try {
      await page.goto('https://www.thebell.co.kr/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      const cookies = await page.cookies();
      this.saveCookies(cookies);
      console.log(`[Thebell] Saved ${cookies.length} cookies from Chrome`);
      return true;
    } catch (error) {
      console.error('[Thebell] Failed to save cookies from Chrome:', error);
      return false;
    } finally {
      await page.close();
    }
  }
}
