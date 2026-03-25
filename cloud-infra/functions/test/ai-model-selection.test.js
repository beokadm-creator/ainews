const assert = require('node:assert/strict');

const { resolveAiConfigForStage, resolveFallbackAiConfig, resolveAiCallOptions } = require('../lib/services/aiService');

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run('filtering stage uses filteringModel when configured', () => {
  const baseConfig = {
    provider: 'openai',
    model: 'gpt-4o',
    filteringModel: 'gpt-4o-mini',
    fallbackProvider: 'openai',
    fallbackModel: 'gpt-4.1-mini',
    maxPendingBatch: 20,
    maxAnalysisBatch: 10,
  };

  const resolved = resolveAiConfigForStage(baseConfig, 'filtering');

  assert.equal(resolved.model, 'gpt-4o-mini');
  assert.equal(resolved.filteringModel, 'gpt-4o-mini');
  assert.equal(resolved.fallbackModel, 'gpt-4.1-mini');
});

run('filtering stage falls back to base model when no filteringModel is set', () => {
  const baseConfig = {
    provider: 'glm',
    model: 'glm-4.7',
    maxPendingBatch: 20,
    maxAnalysisBatch: 10,
  };

  const resolved = resolveAiConfigForStage(baseConfig, 'filtering');

  assert.equal(resolved.model, 'glm-4.7');
});

run('analysis stage always uses the primary model', () => {
  const baseConfig = {
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    filteringModel: 'gemini-2.5-flash',
    maxPendingBatch: 20,
    maxAnalysisBatch: 10,
  };

  const resolved = resolveAiConfigForStage(baseConfig, 'analysis');

  assert.equal(resolved.model, 'gemini-2.5-pro');
  assert.equal(resolved.filteringModel, 'gemini-2.5-flash');
});

run('fallback config switches provider and model for GLM to Gemini failover', () => {
  const baseConfig = {
    provider: 'glm',
    model: 'glm-4.7',
    fallbackProvider: 'gemini',
    fallbackModel: 'gemini-2.5-flash',
    baseUrl: 'https://custom-glm.example.com',
    apiKeyEnvKey: 'GLM_API_KEY',
    maxPendingBatch: 20,
    maxAnalysisBatch: 10,
  };

  const resolved = resolveFallbackAiConfig(baseConfig);

  assert.equal(resolved.provider, 'gemini');
  assert.equal(resolved.model, 'gemini-2.5-flash');
  assert.equal(resolved.baseUrl, undefined);
  assert.equal(resolved.apiKeyEnvKey, 'GEMINI_API_KEY');
});

run('fallback config is disabled when fallback provider matches primary provider', () => {
  const baseConfig = {
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    fallbackProvider: 'gemini',
    maxPendingBatch: 20,
    maxAnalysisBatch: 10,
  };

  const resolved = resolveFallbackAiConfig(baseConfig);

  assert.equal(resolved, null);
});

run('glm relevance tuning disables thinking and sampling for deterministic filtering', () => {
  const resolved = resolveAiCallOptions('glm', 'relevance');

  assert.equal(resolved.thinkingType, 'disabled');
  assert.equal(resolved.doSample, false);
  assert.equal(resolved.structuredJson, true);
  assert.equal(resolved.maxTokens, 120);
});

run('glm analysis tuning disables thinking and keeps structured json output stable', () => {
  const resolved = resolveAiCallOptions('glm', 'analysis');

  assert.equal(resolved.thinkingType, 'disabled');
  assert.equal(resolved.doSample, false);
  assert.equal(resolved.structuredJson, true);
  assert.equal(resolved.maxTokens, 1400);
});

run('non-glm providers do not receive glm-specific tuning defaults', () => {
  const resolved = resolveAiCallOptions('gemini', 'analysis', { temperature: 0.2, maxTokens: 900 });

  assert.equal(resolved.temperature, 0.2);
  assert.equal(resolved.maxTokens, 900);
  assert.equal(resolved.thinkingType, undefined);
  assert.equal(resolved.structuredJson, undefined);
});
