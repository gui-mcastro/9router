export const COMPLETION_CAPABILITIES = {
  "alims-intl/deepseek-v4-flash-0731": {
    supportsCompletion: true,
    supportsFim: true,
    disableThinking: "enable_thinking",
  },
};

export function getCompletionCapability(provider, model) {
  return COMPLETION_CAPABILITIES[`${provider}/${model}`] || null;
}
