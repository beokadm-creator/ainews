const axios = require('axios');
const RSS_SOURCES = [
  { name: '연합뉴스', url: 'https://www.yna.co.kr/rss' },
  { name: 'The Korea Herald', url: 'http://www.koreaherald.com/rss' },
  { name: 'DealStreetAsia', url: 'https://www.dealstreetasia.com/feed/' },
  { name: 'Financial Times', url: 'https://www.ft.com/rss/home' },
  { name: 'MarketWatch', url: 'https://www.marketwatch.com/rss/topstories' },
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed' },
  { name: 'PE Hub', url: 'https://www.pehub.com/feed/' },
  { name: 'PitchBook News', url: 'https://pitchbook.com/news/rss.xml' },
  { name: 'AltAssets', url: 'https://www.altassets.com/rss' },
  { name: 'VentureBeat', url: 'https://venturebeat.com/feed' },
  { name: 'Crunchbase News', url: 'https://news.crunchbase.com/feed/' },
  { name: 'Business Insider', url: 'https://www.businessinsider.com/rss' },
  { name: 'Institutional Investor', url: 'https://www.institutionalinvestor.com/rss' }
];

async function checkRssStatus() {
  console.log('--- RSS ENDPOINT DIAGNOSIS START ---');
  for (const src of RSS_SOURCES) {
    try {
      const start = Date.now();
      const resp = await axios.get(src.url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      console.log(`[OK] ${src.name.padEnd(25)} | HTTP ${resp.status} | ${Date.now() - start}ms`);
    } catch (err) {
      const status = err.response ? err.response.status : 'TIMEOUT/CONN_ERR';
      console.log(`[FAIL] ${src.name.padEnd(25)} | HTTP ${status} | URL: ${src.url}`);
      if (status === 404) {
        console.log(`     => ERROR: URL NOT FOUND (404). Endpoint needs update.`);
      } else if (status === 403) {
        console.log(`     => ERROR: ACCESS FORBIDDEN (403). Scraping recommended.`);
      } else {
        console.log(`     => ERROR: ${err.message}`);
      }
    }
    console.log('------------------------------------------------------------');
  }
}

checkRssStatus();
