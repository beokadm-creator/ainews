import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser } from 'puppeteer';

puppeteer.use(StealthPlugin());

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

export class ThebellService {
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
      // 더벨 로그인 페이지
      await page.goto('https://www.thebell.co.kr/front/login.asp', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // ID 입력
      await page.waitForSelector('input[name="UserID"], input[id*="id"]', {
        timeout: 10000,
      });
      await page.type('input[name="UserID"]', email);

      // 비밀번호 입력
      await page.waitForSelector('input[name="UserPassword"], input[type="password"]', {
        timeout: 10000,
      });
      await page.type('input[name="UserPassword"]', password);

      // 로그인 버튼 클릭
      const loginButton = await page.$('input[type="submit"][value*="로그인"], button[type="submit"]');
      if (loginButton) {
        await loginButton.click();
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // 로그인 성공 여부 확인
      const isLoggedIn = await page.$('[class*="logout"], .user-menu');
      return !!isLoggedIn;
    } catch (error) {
      console.error('Thebell login failed:', error);
      return false;
    } finally {
      await page.close();
    }
  }

  async scrapeArticles(category: string = 'news'): Promise<ScrapingResult> {
    if (!this.browser) await this.init();

    const page = await this.browser!.newPage();
    try {
      const url = `https://www.thebell.co.kr/front/${category}.asp`;
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // 기사 목록 추출
      const articles = await page.evaluate(() => {
        const items: any[] = [];
        const tableRows = document.querySelectorAll('table tr, .article-item, [class*="news-list"] > div');

        tableRows.forEach((row) => {
          const titleEl = row.querySelector('td > a, [class*="title"] > a, a[href*="index"]');
          const dateEl = row.querySelector('td:last-child, .date, [class*="date"]');

          if (titleEl && titleEl instanceof HTMLAnchorElement) {
            items.push({
              title: titleEl.textContent?.trim() || '',
              link: titleEl.href,
              date: dateEl?.textContent?.trim() || new Date().toISOString().split('T')[0],
            });
          }
        });

        return items;
      });

      return {
        success: true,
        data: articles,
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
