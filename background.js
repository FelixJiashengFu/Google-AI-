'use strict';

const DEFAULT_SETTINGS = {
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.4,
  autoExplain: true,
  selectionButton: true,
  screenshotShortcut: true,
  chatgptUrl: 'https://chatgpt.com/'
};

const SYSTEM_PAGE = `你是 dadada 的网页讲解助手，帮中文用户快速读懂正在浏览的网页。请严格依据给出的页面内容，用简体中文输出：
1. 一句话概括这个页面在讲什么；
2. 3-5 个要点，解释关键信息，点出重要数据、结论或时间；
3. 一行「值得注意」，说明容易忽略的细节或与用户可能的关系。
不要编造原文没有的信息；专业术语先通俗解释；使用短小标题和列表，总长度 350 字以内。`;

const SYSTEM_SELECTION = `你是 dadada 的网页讲解助手，用户选中了网页上的一段内容。请用简体中文：
1. 一句话说明这段在讲什么；
2. 结合上下文解释它的含义，术语先用通俗语言说明；
3. 若包含数据、结论或隐含前提，指出它们意味着什么；
4. 若原文是外语，先给中文翻译再讲解。
不要编造；总长度 300 字以内。`;

const SYSTEM_CHAT = `你是 dadada 的网页讲解助手，正在与用户讨论当前网页。只依据【当前页面】内容与对话历史回答；信息不足时直接说明，并请用户补充。用简体中文，简洁、分点，避免空话。`;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get('settings');
  if (!stored.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'explain-selection',
      title: '讲解选中内容',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'explain-page',
      title: '讲解这个页面',
      contexts: ['page']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  const ready = await ensureContent(tab.id);
  if (!ready) return;
  if (info.menuItemId === 'explain-selection') {
    chrome.tabs.sendMessage(tab.id, {
      type: 'explain-selection',
      text: info.selectionText || ''
    });
  } else if (info.menuItemId === 'explain-page') {
    chrome.tabs.sendMessage(tab.id, { type: 'open-panel', tab: 'page' });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ai') {
    handleAI(msg.kind, msg.payload || {}, msg.settings || null)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({
          ok: false,
          code: 'UNKNOWN',
          message: '讲解服务出错',
          detail: String(err && err.message ? err.message : err).slice(0, 300)
        })
      );
    return true;
  }

  if (msg.type === 'test') {
    testConnection(msg.settings || null)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, message: '测试失败', detail: String(err).slice(0, 300) })
      );
    return true;
  }

  if (msg.type === 'list-models') {
    listModels(msg.settings || null)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, message: '获取模型失败', detail: String(err).slice(0, 300) })
      );
    return true;
  }

  if (msg.type === 'capture-visible-tab') {
    captureActiveTab()
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, message: '截图失败', detail: String(err).slice(0, 300) })
      );
    return true;
  }

  if (msg.type === 'paste-to-chatgpt') {
    pasteToChatGPT(msg.dataUrl)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, message: '粘贴失败', detail: String(err).slice(0, 300) })
      );
    return true;
  }
});

async function ensureContent(tabId) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      if (res && res.ok) return true;
    } catch (_) {
      if (attempt === 0) {
        // 页面在扩展安装前打开，尝试补注入
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        } catch (_) {
          return false;
        }
      }
    }
    await sleep(150);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.windowId) {
      return { ok: false, message: '没有找到当前标签页' };
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { ok: true, dataUrl };
  } catch (error) {
    return {
      ok: false,
      message: '这个页面无法截图',
      detail: String(error && error.message ? error.message : error).slice(0, 240)
    };
  }
}

async function pasteToChatGPT(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return { ok: false, message: '截图数据无效' };
  }
  const settings = await readSettings();
  const targetUrl = String(settings.chatgptUrl || 'https://chatgpt.com/');
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (_) {
    return { ok: false, message: 'ChatGPT 地址配置无效' };
  }

  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ url: parsed.origin + '/*' });
    const targetBase = (parsed.origin + parsed.pathname).replace(/\/+$/, '');
    tab =
      tabs.find((candidate) => {
        if (!candidate.url) return false;
        try {
          const current = new URL(candidate.url);
          return (current.origin + current.pathname).replace(/\/+$/, '').startsWith(targetBase);
        } catch (_) {
          return false;
        }
      }) || null;
  } catch (_) {
    tab = null;
  }

  if (tab && tab.id) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch (_) {
        /* ignore */
      }
    }
    await waitForTabLoad(tab.id, 8000);
  } else {
    tab = await chrome.tabs.create({ url: targetUrl, active: true });
    const loaded = await waitForTabLoad(tab.id, 15000);
    if (!loaded) {
      return { ok: false, message: 'ChatGPT 页面加载超时，截图已复制' };
    }
  }

  const ready = await ensureContent(tab.id);
  if (!ready) {
    return { ok: false, message: '无法连接 ChatGPT 页面，截图已复制' };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'paste-image', dataUrl });
    return response || { ok: false, message: 'ChatGPT 没有响应，截图已复制' };
  } catch (error) {
    return {
      ok: false,
      message: '无法连接 ChatGPT 页面，截图已复制',
      detail: String(error && error.message ? error.message : error).slice(0, 240)
    };
  }
}

async function waitForTabLoad(tabId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch (_) {
      return false;
    }
    await sleep(250);
  }
  return false;
}

function modelsEndpoint(apiBase) {
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/chat\/completions$/i.test(base)) {
    return base.replace(/\/chat\/completions$/i, '/models');
  }
  return base + '/models';
}

async function listModels(settingsOverride) {
  const settings = await readSettings(settingsOverride);
  const apiKey = String(settings.apiKey || '').trim();
  const apiBase = String(settings.apiBase || '').trim();
  if (!apiKey) return { ok: false, code: 'NO_KEY', message: '请先填写 API Key' };
  if (!apiBase) return { ok: false, code: 'NO_CONFIG', message: '请先填写接口地址' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(modelsEndpoint(apiBase), {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    return {
      ok: false,
      message: '无法连接到接口',
      detail: String(error && error.message ? error.message : error).slice(0, 240)
    };
  }
  clearTimeout(timer);

  const raw = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      message: `获取模型失败（HTTP ${response.status}）`,
      detail: raw.slice(0, 300)
    };
  }
  try {
    const data = JSON.parse(raw);
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data.data)
        ? data.data
        : Array.isArray(data.models)
          ? data.models
          : [];
    const models = [...new Set(list.map((item) => (typeof item === 'string' ? item : item && item.id)).filter(Boolean))];
    if (!models.length) {
      return { ok: false, message: '接口没有返回可用模型', detail: raw.slice(0, 240) };
    }
    return { ok: true, models };
  } catch (_) {
    return { ok: false, message: '接口返回的不是模型列表', detail: raw.slice(0, 240) };
  }
}

async function readSettings(override) {
  if (override && typeof override === 'object') {
    return { ...DEFAULT_SETTINGS, ...override };
  }
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

function endpoint(apiBase) {
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
}

function truncate(text, limit) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return value.slice(0, limit) + '\n…（内容过长，已截断）';
}

function pageContext(payload, limit) {
  const lines = [];
  lines.push(`标题：${payload.title || '（无标题）'}`);
  lines.push(`网址：${payload.url || ''}`);
  if (Array.isArray(payload.outline) && payload.outline.length) {
    lines.push('', '【页面结构】', ...payload.outline.slice(0, 20).map((h) => '- ' + h));
  }
  if (Array.isArray(payload.results) && payload.results.length) {
    lines.push('', '【搜索结果】');
    payload.results.slice(0, 8).forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}（${r.domain}）`, `   ${r.snippet || ''}`);
    });
  }
  lines.push('', '【页面正文】', truncate(payload.text, limit));
  return lines.join('\n');
}

function buildMessages(kind, payload) {
  if (kind === 'page') {
    let system = SYSTEM_PAGE;
    if (Array.isArray(payload.results) && payload.results.length) {
      system +=
        '\n这是一个 Google 搜索结果页。除了概括主题，请说明这些结果分别从什么角度回答该问题、来源有何差异，并给出 1-2 句检索建议。';
    }
    return [
      { role: 'system', content: system },
      { role: 'user', content: pageContext(payload, 12000) }
    ];
  }

  if (kind === 'selection') {
    const content = [
      `页面标题：${payload.title || '（无标题）'}`,
      `网址：${payload.url || ''}`,
      '',
      '【选中内容】',
      truncate(payload.text, 3000),
      '',
      '【所在段落】',
      truncate(payload.context || '（未取到上下文）', 1500)
    ].join('\n');
    return [
      { role: 'system', content: SYSTEM_SELECTION },
      { role: 'user', content }
    ];
  }

  if (kind === 'chat') {
    const history = Array.isArray(payload.history) ? payload.history.slice(-8) : [];
    return [
      {
        role: 'system',
        content:
          SYSTEM_CHAT +
          '\n\n' +
          pageContext(payload, 6000) +
          (payload.selection
            ? '\n\n【用户此前选中的内容】\n' + truncate(payload.selection, 1200)
            : '')
      },
      ...history.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: truncate(m.content, 2000)
      })),
      { role: 'user', content: truncate(payload.question, 2000) }
    ];
  }

  return null;
}

async function handleAI(kind, payload, settingsOverride) {
  const settings = await readSettings(settingsOverride);
  const apiKey = String(settings.apiKey || '').trim();
  const apiBase = String(settings.apiBase || '').trim();
  const model = String(settings.model || '').trim();

  if (!apiKey) {
    return { ok: false, code: 'NO_KEY', message: '还没有配置 AI 接口' };
  }
  if (!apiBase || !model) {
    return { ok: false, code: 'NO_CONFIG', message: '接口地址或模型名没有填写完整' };
  }

  const messages = buildMessages(kind, payload);
  if (!messages) {
    return { ok: false, code: 'BAD_REQUEST', message: '未知的讲解类型' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch(endpoint(apiBase), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: Number.isFinite(Number(settings.temperature))
          ? Number(settings.temperature)
          : 0.4,
        max_tokens: kind === 'page' ? 1000 : 700
      }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      return { ok: false, code: 'TIMEOUT', message: '请求超时（45 秒），请稍后重试' };
    }
    return {
      ok: false,
      code: 'NETWORK',
      message: '无法连接到 AI 接口',
      detail: String(err && err.message ? err.message : err).slice(0, 240)
    };
  }
  clearTimeout(timer);

  const raw = await response.text();
  if (!response.ok) {
    let detail = '';
    try {
      const parsed = JSON.parse(raw);
      detail =
        (parsed.error && (parsed.error.message || parsed.error.code)) ||
        parsed.message ||
        '';
    } catch (_) {
      detail = raw.slice(0, 240);
    }
    const known = {
      401: 'API Key 无效或已过期',
      403: '没有访问这个模型的权限',
      404: '接口地址或模型名不存在',
      429: '请求过于频繁，或账户额度不足',
      500: '服务端错误',
      502: '网关错误',
      503: '服务暂时不可用'
    };
    return {
      ok: false,
      code: 'HTTP_' + response.status,
      message: known[response.status] || `请求失败（HTTP ${response.status}）`,
      detail: String(detail).slice(0, 300)
    };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    return { ok: false, code: 'BAD_RESPONSE', message: '接口返回的不是 JSON', detail: raw.slice(0, 240) };
  }

  const text = extractText(data);
  if (!text) {
    return {
      ok: false,
      code: 'EMPTY',
      message: '模型没有返回内容，可能触发了长度限制或内容过滤'
    };
  }
  return { ok: true, text, model };
}

function extractText(data) {
  const choice = data && data.choices && data.choices[0];
  if (!choice) return '';
  const content = choice.message && choice.message.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part && part.text ? part.text : ''))
      .join('')
      .trim();
  }
  if (typeof choice.text === 'string') return choice.text.trim();
  return '';
}

async function testConnection(settingsOverride) {
  const settings = await readSettings(settingsOverride);
  if (!String(settings.apiKey || '').trim()) {
    return { ok: false, message: '请先填写 API Key', code: 'NO_KEY' };
  }
  const result = await handleAI(
    'chat',
    {
      title: '连接测试',
      url: '',
      text: '这是一次连接测试，不需要参考任何页面内容。',
      question: '请只回复四个字：连接成功'
    },
    settingsOverride
  );
  if (!result.ok) return result;
  return { ok: true, text: result.text.slice(0, 200), model: result.model };
}
