import 'dotenv/config';
import express, { Request, Response } from 'express';
import { MarketInsightService } from './services/marketInsightService';
import { ThebellService } from './services/thebellService';
import { initFirestore } from './services/firestoreService';
import { collectAllArticles, randomCollectIntervalMs, isKoreanBusinessHours } from './services/collectionService';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());

// Service instances
const marketInsightService = new MarketInsightService();
const thebellService = new ThebellService();

// Initialize services on startup
async function initServices() {
  try {
    await marketInsightService.init();
    await thebellService.init();
    initFirestore();
    console.log('Scraper services initialized');
  } catch (error) {
    console.error('Failed to initialize scraper services:', error);
    process.exit(1);
  }
}

// Chrome 세션 유지 (더벨, 마켓인사이트 로그인 상태 유지)
// 크롤러가 감지하지 못하도록 실제 사용자처럼 주기적으로 페이지 이동
let sessionKeepAliveTimer: NodeJS.Timeout | null = null;
const KEEPALIVE_INTERVAL_MS = 20 * 60 * 1000; // 20분마다

async function runSessionKeepAlive() {
  if (!isKoreanBusinessHours()) return; // 업무시간 외에는 패스
  await thebellService.refreshSession();
  // 사이트 간 자연스러운 간격
  await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000));
  await marketInsightService.refreshSession();
}

function startSessionKeepAlive() {
  sessionKeepAliveTimer = setInterval(() => {
    runSessionKeepAlive().catch(e => console.error('[KeepAlive] Error:', e.message));
  }, KEEPALIVE_INTERVAL_MS);
  console.log(`[KeepAlive] Session keepalive started (every ${KEEPALIVE_INTERVAL_MS / 60000}min)`);
}

// Auto-collection scheduler (시간대별 분산, 업무시간만)
// TheBell: 매 시간 0분 (0~30분 내 랜덤)
// MarketInsight: 매 시간 31분 (31~60분 내 랜덤)
let hourlyScheduler: NodeJS.Timeout | null = null;

async function runTheBellCollection() {
  if (!isKoreanBusinessHours()) {
    console.log('[TheBell Collect] Outside business hours — skipping');
    return;
  }

  const randomDelay = Math.floor(Math.random() * (30 * 60 * 1000)); // 0~30분 랜덤
  console.log(`[TheBell Collect] Will start in ${Math.round(randomDelay / 1000)}s`);

  setTimeout(async () => {
    if (!isKoreanBusinessHours()) return;
    console.log('[TheBell Collect] Starting...');
    try {
      const { thebell } = await collectAllArticles(marketInsightService, thebellService, { onlyTheBell: true });
      console.log(`[TheBell Collect] ✓ Complete: ${thebell.collected} saved`);
    } catch (e: any) {
      console.error('[TheBell Collect] Error:', e.message);
    }
  }, randomDelay);
}

async function runMarketInsightCollection() {
  if (!isKoreanBusinessHours()) {
    console.log('[MarketInsight Collect] Outside business hours — skipping');
    return;
  }

  const randomDelay = Math.floor(Math.random() * (30 * 60 * 1000)); // 31~60분 내 랜덤 (30분 + 0~30분)
  console.log(`[MarketInsight Collect] Will start in ${Math.round(randomDelay / 1000)}s`);

  setTimeout(async () => {
    if (!isKoreanBusinessHours()) return;
    console.log('[MarketInsight Collect] Starting...');
    try {
      const { marketinsight } = await collectAllArticles(marketInsightService, thebellService, { onlyMarketInsight: true });
      console.log(`[MarketInsight Collect] ✓ Complete: ${marketinsight.collected} saved`);
    } catch (e: any) {
      console.error('[MarketInsight Collect] Error:', e.message);
    }
  }, randomDelay);
}

function startHourlyScheduler() {
  console.log('[Scheduler] Time-based collection started');
  console.log('[Scheduler] TheBell: every hour at 0-30 min (random within 0-30min)');
  console.log('[Scheduler] MarketInsight: every hour at 31-60 min (random within 31-60min)');

  hourlyScheduler = setInterval(() => {
    const now = new Date();
    const minute = now.getMinutes();

    // TheBell: 정시(0분)에 시작
    if (minute === 0) {
      console.log(`[Scheduler] ${now.toISOString()} - Triggering TheBell collection`);
      runTheBellCollection();
    }

    // MarketInsight: 31분에 시작
    if (minute === 31) {
      console.log(`[Scheduler] ${now.toISOString()} - Triggering MarketInsight collection`);
      runMarketInsightCollection();
    }
  }, 60 * 1000); // 매 분마다 체크
}

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// MarketInsight endpoints
app.post('/api/marketinsight/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const success = await marketInsightService.login(email, password);
    res.json({ success, message: success ? 'Login successful' : 'Login failed' });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/marketinsight/scrape', async (req: Request, res: Response) => {
  try {
    const { section = 'mna', page = '1' } = req.query;
    const result = await marketInsightService.scrapeArticles(section as string, parseInt(page as string));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.get('/api/marketinsight/scrape-all', async (req: Request, res: Response) => {
  try {
    const { section = 'mna', maxPages = '100' } = req.query;
    const result = await (marketInsightService as any).scrapeArticlesAllPages(section as string, parseInt(maxPages as string));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.get('/api/marketinsight/article', async (req: Request, res: Response) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url parameter required' });
    const result = await marketInsightService.scrapeArticleDetail(url as string);
    if (!result) return res.status(404).json({ error: 'Article not found' });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Thebell endpoints
app.post('/api/thebell/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const success = await thebellService.login(email, password);
    res.json({ success, message: success ? 'Login successful' : 'Login failed' });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/thebell/article', async (req: Request, res: Response) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url parameter required' });
    const result = await thebellService.scrapeArticleDetail(url as string);
    if (!result) return res.status(404).json({ error: 'Article not found' });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.get('/api/thebell/scrape', async (req: Request, res: Response) => {
  try {
    const { category = 'news' } = req.query;
    const result = await thebellService.scrapeArticles(category as string);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.get('/api/thebell/keyword-news', async (req: Request, res: Response) => {
  try {
    const { maxPages = '50' } = req.query;
    const result = await (thebellService as any).scrapeKeywordNews(parseInt(maxPages as string));
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Manual collection trigger (scrape + push to Firestore)
app.post('/api/collect', async (req: Request, res: Response) => {
  try {
    const result = await collectAllArticles(marketInsightService, thebellService);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// 쿠키 저장 (Chrome에 로그인된 상태에서 한 번만 실행)
app.post('/api/save-cookies', async (req: Request, res: Response) => {
  try {
    const miResult = await marketInsightService.saveCookiesFromChrome();
    const tbResult = await thebellService.saveCookiesFromChrome();
    res.json({
      success: miResult && tbResult,
      marketinsight: miResult,
      thebell: tbResult,
      message: '쿠키가 저장되었습니다. 이제 PC 재시작 후에도 자동 로그인됩니다.',
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Graceful shutdown
async function shutdown() {
  if (hourlyScheduler) clearInterval(hourlyScheduler);
  if (sessionKeepAliveTimer) clearInterval(sessionKeepAliveTimer);
  await marketInsightService.close();
  await thebellService.close();
  process.exit(0);
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  await shutdown();
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing HTTP server');
  await shutdown();
});

// Start server
initServices().then(() => {
  app.listen(PORT, () => {
    console.log(`Local scraper server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Collect all -> Firestore: POST http://localhost:${PORT}/api/collect`);
    console.log(`MarketInsight scrape: GET http://localhost:${PORT}/api/marketinsight/scrape`);
    console.log(`Thebell scrape: GET http://localhost:${PORT}/api/thebell/scrape`);
    console.log(`Thebell keyword news: GET http://localhost:${PORT}/api/thebell/keyword-news`);
    console.log(`MarketInsight all pages: GET http://localhost:${PORT}/api/marketinsight/scrape-all`);
  });
  startHourlyScheduler();
  startSessionKeepAlive();
});
