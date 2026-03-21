import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Page, Browser } from 'puppeteer';

puppeteer.use(StealthPlugin());

export interface ScrapingResult {
  success: boolean;
  data?: {
    title: string;
    link: string;
    date: string;
    content?: string;
  }[];
  message?: string;
  error?: string;
}

export class MarketInsightService {
  private browser: Browser | null = null;

  async init(): Promise<void> {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
      });
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async login(email: string, password: string): Promise<boolean> {
    if (!this.browser) await this.init();

    const page = await this.browser!.newPage();
    try {
      // 홈페이지 로드
      await page.goto('https://www.marketinsight.co.kr/', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // 로그인 링크 찾아 클릭
      const loginLink = await page.$('a[href*="login"], button:contains("로그인")');
      if (loginLink) {
        await loginLink.click();
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
      }

      // 이메일 입력
      await page.waitForSelector('input[type="email"], input[name*="email"], input[id*="email"]', {
        timeout: 10000,
      });
      await page.type('input[type="email"]', email);

      // 비밀번호 입력
      await page.waitForSelector('input[type="password"]', { timeout: 10000 });
      await page.type('input[type="password"]', password);

      // 로그인 버튼 클릭
      const loginButton = await page.$('button[type="submit"], input[type="submit"][value*="로그인"]');
      if (loginButton) {
        await loginButton.click();
        await new Promise(resolve => setTimeout(resolve, 3000)); // 로그인 완료 대기
      }

      // 로그인 성공 여부 확인
      const isLoggedIn = await page.$('.user-menu, [class*="logout"]');
      return !!isLoggedIn;
    } catch (error) {
      console.error('MarketInsight login failed:', error);
      return false;
    } finally {
      await page.close();
    }
  }

  async scrapeArticles(categories: string[] = ['M&A'], keywords: string[] = []): Promise<ScrapingResult> {
    if (!this.browser) await this.init();

    const page = await this.browser!.newPage();
    try {
      // 기본 카테고리가 없으면 M&A 사용
      const targetCategories = categories && categories.length > 0 ? categories : ['M&A'];

      const allArticles: any[] = [];

      // 각 카테고리별로 스크래핑
      for (const category of targetCategories) {
        const url = `https://www.marketinsight.co.kr/news/${category.toLowerCase()}`;
        await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });

        // 기사 목록 추출
        const articles = await page.evaluate(() => {
          const items: any[] = [];
          const articleElements = document.querySelectorAll('article, .article-item, [class*="news-item"]');

          articleElements.forEach((element) => {
            const titleEl = element.querySelector('h2, h3, [class*="title"], a');
            const linkEl = element.querySelector('a[href]');
            const dateEl = element.querySelector('.date, [class*="date"], time');

            if (titleEl && linkEl) {
              items.push({
                title: titleEl.textContent?.trim() || '',
                link: (linkEl as HTMLAnchorElement).href,
                date: dateEl?.textContent?.trim() || new Date().toISOString().split('T')[0],
              });
            }
          });

          return items;
        });

        allArticles.push(...articles);
      }

      // 키워드 필터링
      let filtered = allArticles;
      if (keywords && keywords.length > 0) {
        filtered = allArticles.filter(article =>
          keywords.some(kw => article.title.toLowerCase().includes(kw.toLowerCase()))
        );
      }

      // 중복 제거
      const uniqueArticles = Array.from(
        new Map(filtered.map(item => [item.link, item])).values()
      );

      return {
        success: true,
        data: uniqueArticles,
        message: `${uniqueArticles.length}개 기사 수집`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      await page.close();
    }
  }
}
