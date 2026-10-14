/** AI 助手词条：右下角浮层对话与设置区块。 */
export const aiZh = {
  'ai.title': 'AI 助手',
  'ai.open': '打开 AI 助手',
  'ai.close': '关闭',
  'ai.placeholder': '问点关于 weave 的…（Enter 发送，Shift+Enter 换行）',
  'ai.send': '发送',
  'ai.stop': '停止生成',
  'ai.clear': '清空对话',
  'ai.empty': '还没有对话。助手已加载 weave 的功能文档与内置技能，只回答 weave 相关问题——可直接提问。',
  'ai.docsMissing': '（未找到仓库 docs/，本次只注入了内置技能）',
  'ai.intro': '回答范围仅限 weave（功能/用法/配置/架构/技能，越界会礼貌拒答）；依据下方注入的资料。',
  'ai.thinking': '正在生成…',
  'ai.emptyAnswer': '（上游没有返回内容——检查模型名、端点是否支持该对话接口）',
  'ai.failed': 'AI 请求失败：{error}',

  'settings.ai': 'AI 助手',
  'settings.aiHint':
    '配置好 OpenAI 兼容端点后，右下角出现助手按钮。API key 只写在服务端（<dataDir>/ai.json），不会回显到浏览器；改密/改 key 均不影响会话。',
  'settings.aiBaseUrl': 'API 地址',
  'settings.aiBaseUrlPlaceholder': 'https://api.example.com/v1',
  'settings.aiModel': '模型',
  'settings.aiModelPlaceholder': 'gpt-4o-mini',
  'settings.aiApiKey': 'API Key',
  'settings.aiApiKeySet': '已设置（留空 = 保持不变）',
  'settings.aiApiKeyUnset': '未设置',
  'settings.aiApiKeyClear': '清除',
  'settings.aiApiKeyShow': '显示',
  'settings.aiApiKeyHide': '隐藏',
};

export const aiEn: Record<keyof typeof aiZh, string> = {
  'ai.title': 'AI assistant',
  'ai.open': 'Open the AI assistant',
  'ai.close': 'Close',
  'ai.placeholder': 'Ask about weave… (Enter to send, Shift+Enter for a newline)',
  'ai.send': 'Send',
  'ai.stop': 'Stop generating',
  'ai.clear': 'Clear chat',
  'ai.empty':
    'No messages yet. The assistant has weave’s feature docs and built-in skills loaded and answers weave questions only — just ask.',
  'ai.docsMissing': ' (repo docs/ not found — only built-in skills were injected)',
  'ai.intro':
    'Scope is limited to weave (features / usage / config / architecture / skills; off-topic asks are politely declined). Answers rely on the injected material below.',
  'ai.thinking': 'Generating…',
  'ai.emptyAnswer':
    '(The upstream returned no content — check the model name and that the endpoint supports chat completions.)',
  'ai.failed': 'AI request failed: {error}',

  'settings.ai': 'AI assistant',
  'settings.aiHint':
    'Point this at an OpenAI-compatible endpoint and the assistant button appears bottom-right. The API key is stored server-side only (<dataDir>/ai.json) and never sent back to the browser.',
  'settings.aiBaseUrl': 'API base URL',
  'settings.aiBaseUrlPlaceholder': 'https://api.example.com/v1',
  'settings.aiModel': 'Model',
  'settings.aiModelPlaceholder': 'gpt-4o-mini',
  'settings.aiApiKey': 'API key',
  'settings.aiApiKeySet': 'Set (leave blank to keep)',
  'settings.aiApiKeyUnset': 'Not set',
  'settings.aiApiKeyClear': 'Clear',
  'settings.aiApiKeyShow': 'Show',
  'settings.aiApiKeyHide': 'Hide',
};
