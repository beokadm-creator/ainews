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

// Auto-collection scheduler (랜덤 간격, 업무시간만)
let collectTimer: NodeJS.Timeout | null = null;

function scheduleNextCollect() {
  const intervalMs = randomCollectIntervalMs();
  const intervalMin = Math.round(intervalMs / 60000);
  console.log(`[AutoCollect] Next collection in ~${intervalMin} min`);

  collectTimer = setTimeout(async () => {
    if (!isKoreanBusinessHours()) {
      console.log('[AutoCollect] Outside business hours — rescheduling');
      scheduleNextCollect();
      return;
    }
    console.log('[AutoCollect] Starting scheduled collection...');
    try {
      await collectAllArticles(marketInsightService, thebellService);
    } catch (e: any) {
      console.error('[AutoCollect] Error:', e.message);
    }
    scheduleNextCollect(); // 완료 후 다음 스케줄 예약
  }, intervalMs);
}

function startAutoCollect() {
  // 서버 시작 후 30~90초 랜덤 딜레이로 첫 수집 (정각 출발 방지)
  const startDelay = 30000 + Math.floor(Math.random() * 60000);
  console.log(`[AutoCollect] First collection in ${Math.round(startDelay / 1000)}s`);
  setTimeout(async () => {
    if (isKoreanBusinessHours()) {
      try {
        await collectAllArticles(marketInsightService, thebellService);
      } catch (e: any) {
        console.error('[AutoCollect] First run error:', e.message);
      }
    }
    scheduleNextCollect();
  }, startDelay);
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
  if (collectTimer) clearTimeout(collectTimer);
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
  });
  startAutoCollect();
});
