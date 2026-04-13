import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser } from 'puppeteer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

puppeteer.use(StealthPlugin());

const COOKIES_FILE = path.join(__dirname, '../../cookies/marketinsight.json');

export interface ScrapingResult {
  success: boolean;
  data?: {
    title: string;
    link: string;
    date: string;
    content?: string;
  }[];
  error?: string;
}

export class MarketInsightService {
  private browser: Browser | null = null;
  private isConnectedToChrome: boolean = false;

  async init(): Promise<void> {
    if (this.browser) return;

    // Chrome 9222 포트 연결 시도
    try {
      const response = await axios.get('http://localhost:9222/json/version', { timeout: 2000 });
      const wsUrl = response.data.webSocketDebuggerUrl;
      this.browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null,
        protocolTimeout: 180000,
      }) as unknown as Browser;
      this.isConnectedToChrome = true;
      console.log('[MarketInsight] Connected to existing Chrome instance!');
    } catch {
      console.log('[MarketInsight] Chrome not available, launching headless browser...');
      this.browser = await puppeteer.launch({
        headless: true,
        protocolTimeout: 180000,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--js-flags=--max-old-space-size=512',
          '--disable-gpu',
          '--disable-software-rasterizer',
        ],
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
      console.log('[MarketInsight] No saved cookies found');
    }
    return [];
  }

  private saveCookies(cookies: any[]): void {
    try {
      const dir = path.dirname(COOKIES_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
      console.log('[MarketInsight] Cookies saved!');
    } catch (e) {
      console.error('[MarketInsight] Failed to save cookies:', e);
    }
  }

  async login(email: string, password: string): Promise<boolean> {
    if (!this.browser) await this.init();

    const page = await this.browser!.newPage();
    try {
      // 1. 저장된 쿠키 로드
      const savedCookies = this.loadCookies();
      if (savedCookies.length > 0) {
        console.log('[MarketInsight] Loading saved cookies...');
        await page.setCookie(...savedCookies);
      }

      // 2. 홈페이지 로드
      console.log('[MarketInsight] Loading homepage...');
      await page.goto('https://marketinsight.hankyung.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });

      // 3. 로그인 상태 확인
      const isLoggedIn = await page.$('.user-menu, [class*="logout"], [class*="user-profile"], .login-info');
      if (isLoggedIn) {
        console.log('[MarketInsight] Already logged in via cookies!');
        const cookies = await page.cookies();
        this.saveCookies(cookies);
        return true;
      }

      // 4. 쿠키로 안 되면 ID/PW 로그인
      console.log('[MarketInsight] Attempting login with ID/PW...');
      await page.waitForSelector('#user_id', { timeout: 10000 });
      await page.type('#user_id', email);
      await page.waitForSelector('#password', { timeout: 10000 });
      await page.type('#password', password);

      const loginSelectors = ['button[type="submit"]', 'input[type="submit"]', 'button.btn-login', '.btn-login'];
      for (const selector of loginSelectors) {
        const button = await page.$(selector);
        if (button) {
          await button.click();
          break;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 5000));

      const isLoggedInNow = await page.$('.user-menu, [class*="logout"], [class*="user-profile"], .login-info');
      if (isLoggedInNow) {
        const cookies = await page.cookies();
        this.saveCookies(cookies);
        console.log('[MarketInsight] Login successful! Cookies saved.');
        return true;
      }

      console.log('[MarketInsight] Login failed');
      return false;
    } catch (error) {
      console.error('[MarketInsight] Login error:', error);
      return false;
    } finally {
      await page.close();
    }
  }

  // ─── 모든 페이지 수집 ────────────────────────────────────────────────
  async scrapeArticlesAllPages(section: string = 'mna', maxPages: number = 100): Promise<ScrapingResult> {
    if (!this.browser) await this.init();

    const allArticles: any[] = [];
    const seen = new Set<string>();

    try {
      const savedCookies = this.loadCookies();

      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const page = await this.browser!.newPage();
        try {
          if (savedCookies.length > 0) await page.setCookie(...savedCookies);

          const url = `https://marketinsight.hankyung.com/${section}?page=${pageNum}`;
          console.log(`[MarketInsight] Scraping page ${pageNum}: ${url}`);
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000)); // 자연스러운 로딩

          const pageArticles = await page.evaluate(() => {
            const items: any[] = [];
            document.querySelectorAll('.news-list li').forEach((li: Element) => {
              const titleEl = li.querySelector('.news-tit a') as HTMLAnchorElement;
              const categoryEl = li.querySelector('.news-category a');
              const leadEl = li.querySelector('.lead');

              if (titleEl && titleEl.href) {
                items.push({
                  title: titleEl.textContent?.trim() || '',
                  link: titleEl.href,
                  date: new Date().toISOString().split('T')[0],
                  category: categoryEl?.textContent?.trim() || '',
                  summary: leadEl?.textContent?.trim().slice(0, 200) || '',
                });
              }
            });
            return items;
          });

          if (pageArticles.length === 0) {
            console.log(`[MarketInsight] No articles on page ${pageNum} — stopping`);
            break;
          }

          // 중복 제거
          pageArticles.forEach((a: any) => {
            if (!seen.has(a.link)) {
              seen.add(a.link);
              allArticles.push(a);
            }
          });

          console.log(`[MarketInsight] Page ${pageNum}: ${pageArticles.length} articles (${allArticles.length} total)`);
          await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500)); // 페이지 간 대기
        } catch (error: any) {
          console.warn(`[MarketInsight] Page ${pageNum} failed:`, error.message);
          if (pageNum === 1) throw error; // 첫 페이지 실패는 치명적
          break;
        } finally {
          await page.close();
        }
      }

      console.log(`[MarketInsight] Total articles: ${allArticles.length}`);
      return { success: true, data: allArticles };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  // ─── 단일 페이지 수집 (호환성 유지) ──────────────────────────────────
  async scrapeArticles(section: string = 'mna', pageNum: number = 1): Promise<ScrapingResult> {
    if (!this.browser) await this.init();

    const page = await this.browser!.newPage();
    try {
      const savedCookies = this.loadCookies();
      if (savedCookies.length > 0) await page.setCookie(...savedCookies);

      const url = `https://marketinsight.hankyung.com/${section}?page=${pageNum}`;
      console.log(`[MarketInsight] Scraping single page: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

      const articles = await page.evaluate(() => {
        const items: any[] = [];
        document.querySelectorAll('.news-list li').forEach((li: Element) => {
          const titleEl = li.querySelector('.news-tit a') as HTMLAnchorElement;
          const categoryEl = li.querySelector('.news-category a');
          const leadEl = li.querySelector('.lead');

          if (titleEl && titleEl.href) {
            items.push({
              title: titleEl.textContent?.trim() || '',
              link: titleEl.href,
              date: new Date().toISOString().split('T')[0],
              category: categoryEl?.textContent?.trim() || '',
              summary: leadEl?.textContent?.trim().slice(0, 200) || '',
            });
          }
        });
        return items;
      });

      console.log(`[MarketInsight] Scraped ${articles.length} articles`);
      return { success: true, data: articles };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    } finally {
      await page.close();
    }
  }

  async scrapeArticleDetail(url: string): Promise<{ title: string; subtitle: string; date: string; content: string } | null> {
    if (!this.browser) await this.init();

    const page = await this.browser!.newPage();
    try {
      const savedCookies = this.loadCookies();
      if (savedCookies.length > 0) await page.setCookie(...savedCookies);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // 사람처럼: 페이지 로드 후 짧은 대기 + 스크롤 시뮬레이션
      await new Promise(r => setTimeout(r, 1200 + Math.random() * 1800));
      await page.evaluate(async () => {
        const h = document.body.scrollHeight;
        const steps = 4;
        for (let i = 1; i <= steps; i++) {
          window.scrollTo(0, (h * i) / steps);
          await new Promise(r => setTimeout(r, 250 + Math.random() * 350));
        }
      });
      await new Promise(r => setTimeout(r, 500 + Math.random() * 800));

      const detail = await page.evaluate(() => {
        const title = document.querySelector('.article-head .article-tit')?.textContent?.trim() || '';
        const subtitle = document.querySelector('.article-head .article-subtit')?.textContent?.trim().replace(/\s+/g, ' ') || '';
        const dates = document.querySelectorAll('.article-head .date-info .date');
        const date = dates[0]?.textContent?.trim() || '';

        // 본문 (이미지, 버튼 등 제거)
        const bodyEl = document.querySelector('.article-body');
        if (bodyEl) {
          bodyEl.querySelectorAll('figure, button, .article-figure').forEach(el => el.remove());
          const content = bodyEl.textContent?.trim().replace(/\s+/g, ' ') || '';
          return { title, subtitle, date, content };
        }
        return null;
      });

      return detail;
    } catch (error) {
      console.error('[MarketInsight] Article detail error:', error);
      return null;
    } finally {
      await page.close();
    }
  }

  // 세션 유지 (주기적 호출 — 로그인 상태 유지 + 쿠키 갱신)
  async refreshSession(): Promise<boolean> {
    if (!this.browser) return false;
    const page = await this.browser.newPage();
    try {
      const savedCookies = this.loadCookies();
      if (savedCookies.length > 0) await page.setCookie(...savedCookies);
      await page.goto('https://marketinsight.hankyung.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
      const cookies = await page.cookies();
      if (cookies.length > 0) {
        this.saveCookies(cookies);
        console.log('[MarketInsight] Session refreshed');
        return true;
      }
      return false;
    } catch (e: any) {
      console.warn('[MarketInsight] Session refresh failed:', e.message);
      return false;
    } finally {
      await page.close();
    }
  }

  // 현재 Chrome 세션에서 쿠키 추출해서 저장
  async saveCookiesFromChrome(): Promise<boolean> {
    if (!this.browser) await this.init();

    const page = await this.browser!.newPage();
    try {
      await page.goto('https://marketinsight.hankyung.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      const cookies = await page.cookies();
      this.saveCookies(cookies);
      console.log(`[MarketInsight] Saved ${cookies.length} cookies from Chrome`);
      return true;
    } catch (error) {
      console.error('[MarketInsight] Failed to save cookies from Chrome:', error);
      return false;
    } finally {
      await page.close();
    }
  }
}
