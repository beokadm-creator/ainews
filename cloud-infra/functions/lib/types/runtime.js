"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROVIDER_DEFAULTS = void 0;
// Provider-specific defaults
exports.PROVIDER_DEFAULTS = {
    glm: { model: 'glm-4', apiKeyEnvKey: 'GLM_API_KEY' },
    gemini: { model: 'gemini-1.5-pro', apiKeyEnvKey: 'GEMINI_API_KEY' },
    openai: { model: 'gpt-4o', apiKeyEnvKey: 'OPENAI_API_KEY' },
    claude: { model: 'claude-3-5-sonnet-20241022', apiKeyEnvKey: 'ANTHROPIC_API_KEY' },
};
//# sourceMappingURL=runtime.js.map