import express, { Request, Response } from 'express';
import { MarketInsightService } from './services/marketInsightService';
import { ThebellService } from './services/thebellService';

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
    console.log('Scraper services initialized');
  } catch (error) {
    console.error('Failed to initialize scraper services:', error);
    process.exit(1);
  }
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
    const { category = 'mna' } = req.query;
    const result = await marketInsightService.scrapeArticles(category as string);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
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

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  await marketInsightService.close();
  await thebellService.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing HTTP server');
  await marketInsightService.close();
  await thebellService.close();
  process.exit(0);
});

// Start server
initServices().then(() => {
  app.listen(PORT, () => {
    console.log(`Local scraper server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`MarketInsight login: POST http://localhost:${PORT}/api/marketinsight/login`);
    console.log(`MarketInsight scrape: GET http://localhost:${PORT}/api/marketinsight/scrape`);
    console.log(`Thebell login: POST http://localhost:${PORT}/api/thebell/login`);
    console.log(`Thebell scrape: GET http://localhost:${PORT}/api/thebell/scrape`);
  });
});
