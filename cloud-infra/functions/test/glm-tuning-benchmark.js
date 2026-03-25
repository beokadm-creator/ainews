const axios = require('axios');
const assert = require('node:assert/strict');

const apiKey = process.env.GLM_API_KEY;
const baseUrl = (process.env.GLM_BASE_URL || 'https://api.z.ai/api/paas/v4/chat/completions').replace(/\/$/, '');
const model = process.env.GLM_MODEL || 'glm-4.7';

if (!apiKey) {
  console.error('Missing GLM_API_KEY');
  process.exit(1);
}

const article = {
  title: '나우IB캐피탈, 400억 코리아IT펀드 클로징 임박',
  source: '더벨',
  publishedAt: '2026-03-25T09:00:00+09:00',
  content:
    '나우IB캐피탈이 약 400억원 규모의 코리아IT펀드 결성을 마무리하고 있다. 주요 출자자는 국내 기관투자가이며, 향후 정보기술 및 디지털 전환 분야 중소기업 투자에 나설 계획이다. 시장에서는 이번 펀드 결성을 통해 정보기술 섹터의 바이아웃과 성장투자 기회가 확대될 수 있다는 관측이 나온다.',
};

const prompts = {
  relevance: `You classify whether an article is relevant to M&A, private equity, venture capital, fundraising, IPO, stake sale, or corporate finance.\nReturn only JSON.\n{"relevant":true,"confidence":0.0,"reason":"short Korean reason"}\n\nTitle: ${article.title}\nSource: ${article.source}\nContent: ${article.content}`,
  analysis: `You extract structured deal intelligence from an article.\nReturn only JSON.\n{"companies":{"acquiror":null,"target":null,"financialSponsor":null},"deal":{"type":"","amount":"","stake":null},"summary":[""],"category":"","insights":"","tags":[""]}\n\nTitle: ${article.title}\nSource: ${article.source}\nPublishedAt: ${article.publishedAt}\nContent: ${article.content}`,
  report: `Create a concise Korean investment briefing in JSON.\nReturn only JSON.\n{"title":"","summary":"","highlights":[{"title":"","description":"","articleIndex":1}],"trends":[{"topic":"","description":"","relatedArticles":[1]}],"risks":[""],"opportunities":[""],"nextSteps":[""]}\n\n[1] ${article.title}\nSource: ${article.source}\nPublishedAt: ${article.publishedAt}\nContent: ${article.content}`,
};

const profiles = [
  {
    name: 'relevance-legacy',
    task: 'relevance',
    body: {
      model,
      messages: [{ role: 'user', content: prompts.relevance }],
      temperature: 0,
      max_tokens: 1000,
    },
  },
  {
    name: 'relevance-tuned',
    task: 'relevance',
    body: {
      model,
      messages: [{ role: 'user', content: prompts.relevance }],
      temperature: 0,
      max_tokens: 120,
      do_sample: false,
      thinking: { type: 'disabled', clear_thinking: true },
      response_format: { type: 'json_object' },
    },
  },
  {
    name: 'analysis-legacy',
    task: 'analysis',
    body: {
      model,
      messages: [{ role: 'user', content: prompts.analysis }],
      temperature: 0.3,
    },
  },
  {
    name: 'analysis-disabled-json',
    task: 'analysis',
    body: {
      model,
      messages: [{ role: 'user', content: prompts.analysis }],
      temperature: 0,
      max_tokens: 1400,
      do_sample: false,
      thinking: { type: 'disabled', clear_thinking: true },
      response_format: { type: 'json_object' },
    },
  },
  {
    name: 'analysis-tuned',
    task: 'analysis',
    body: {
      model,
      messages: [{ role: 'user', content: prompts.analysis }],
      temperature: 0,
      max_tokens: 1400,
      do_sample: false,
      thinking: { type: 'enabled', clear_thinking: true },
      response_format: { type: 'json_object' },
    },
  },
  {
    name: 'report-legacy',
    task: 'report',
    body: {
      model,
      messages: [{ role: 'user', content: prompts.report }],
      temperature: 0.3,
      max_tokens: 4000,
    },
  },
  {
    name: 'report-disabled-json',
    task: 'report',
    body: {
      model,
      messages: [{ role: 'user', content: prompts.report }],
      temperature: 0.2,
      max_tokens: 4000,
      do_sample: false,
      thinking: { type: 'disabled', clear_thinking: true },
      response_format: { type: 'json_object' },
    },
  },
  {
    name: 'report-tuned',
    task: 'report',
    body: {
      model,
      messages: [{ role: 'user', content: prompts.report }],
      temperature: 0.2,
      max_tokens: 4000,
      thinking: { type: 'enabled', clear_thinking: true },
      response_format: { type: 'json_object' },
    },
  },
];

function validate(task, content) {
  let parsed;
  try {
    parsed = JSON.parse(
      content
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/, '')
        .match(/\{[\s\S]*\}/)?.[0] || content,
    );
  } catch (error) {
    console.error('INVALID_CONTENT_START');
    console.error(content);
    console.error('INVALID_CONTENT_END');
    throw error;
  }
  if (task === 'relevance') {
    assert.equal(typeof parsed.relevant, 'boolean');
    assert.equal(typeof parsed.confidence, 'number');
    assert.equal(typeof parsed.reason, 'string');
  }
  if (task === 'analysis') {
    assert.ok(Array.isArray(parsed.summary));
    assert.equal(typeof parsed.category, 'string');
    assert.ok(Array.isArray(parsed.tags));
  }
  if (task === 'report') {
    assert.equal(typeof parsed.title, 'string');
    assert.ok(Array.isArray(parsed.highlights));
    assert.ok(Array.isArray(parsed.risks));
  }
}

async function runOne(profile) {
  const started = Date.now();
  const response = await axios.post(baseUrl, profile.body, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 240000,
  });
  const latencyMs = Date.now() - started;
  const message = response.data?.choices?.[0]?.message || {};
  const content = `${message.content || ''}`.trim();
  let valid = true;
  let validationError = null;
  try {
    validate(profile.task, content);
  } catch (error) {
    valid = false;
    validationError = error.message || String(error);
  }
  return {
    name: profile.name,
    task: profile.task,
    latencyMs,
    totalTokens: response.data?.usage?.total_tokens || 0,
    promptTokens: response.data?.usage?.prompt_tokens || 0,
    completionTokens: response.data?.usage?.completion_tokens || 0,
    hasReasoning: Boolean(message.reasoning_content),
    contentLength: content.length,
    valid,
    validationError,
  };
}

(async () => {
  const results = [];
  for (const profile of profiles) {
    const result = await runOne(profile);
    results.push(result);
    console.log(JSON.stringify(result));
  }

  const summary = {
    model,
    baseUrl,
    ranAt: new Date().toISOString(),
    results,
  };
  console.log('SUMMARY');
  console.log(JSON.stringify(summary, null, 2));
})().catch((error) => {
  const responseData = error?.response?.data;
  console.error('GLM tuning benchmark failed');
  if (responseData) {
    console.error(JSON.stringify(responseData, null, 2));
  } else {
    console.error(error?.stack || error?.message || String(error));
  }
  process.exit(1);
});
