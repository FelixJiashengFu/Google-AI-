'use strict';

const DEFAULTS = {
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.4,
  autoExplain: true,
  selectionButton: true
};

const BLOCKED_HOSTS = ['chrome.google.com', 'chromewebstore.google.com'];

const $ = (id) => document.getElementById(id);

init();

async function init() {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...DEFAULTS, ...(stored.settings || {}) };
  const connected = !!String(settings.apiKey || '').trim();

  $('status').textContent = connected
    ? 'AI 已连接 · ' + (settings.model || '默认模型')
    : '本地模式 · 未连接 AI';
  $('dot').classList.toggle('online', connected);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || '';
  const supported =
    /^(https?|file):/i.test(url) &&
    !BLOCKED_HOSTS.some((host) => url.includes(host));

  if (!tab || !tab.id || !supported) {
    $('pageTitle').textContent = tab
      ? '这个页面不允许扩展运行（浏览器内部页面或扩展商店）'
      : '没有找到当前标签页';
    $('pageTitle').classList.add('warn');
    $('toggle').disabled = true;
    $('toggle').textContent = '此页面不可用';
  } else {
    $('pageTitle').textContent = tab.title || url;
  }

  $('toggle').addEventListener('click', async () => {
    if (!tab || !tab.id) return;
    $('toggle').disabled = true;
    $('toggle').textContent = '正在打开…';
    const ready = await ensureContent(tab.id);
    if (!ready) {
      $('pageTitle').textContent = '无法注入脚本，请刷新页面后重试';
      $('pageTitle').classList.add('warn');
      $('toggle').disabled = false;
      $('toggle').textContent = '重试';
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
      window.close();
    } catch (_) {
      $('pageTitle').textContent = '页面没有响应，请刷新后重试';
      $('pageTitle').classList.add('warn');
      $('toggle').disabled = false;
      $('toggle').textContent = '重试';
    }
  });

  $('settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  $('refreshHint').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html#usage') });
    window.close();
  });
}

async function ensureContent(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (response && response.ok) return true;
  } catch (_) {
    /* 需要补注入 */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((resolve) => setTimeout(resolve, 120));
    return true;
  } catch (_) {
    return false;
  }
}
