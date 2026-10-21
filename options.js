'use strict';

const DEFAULTS = {
  apiBase: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.4,
  autoExplain: true,
  selectionButton: true,
  screenshotShortcut: true
};

const PRESETS = {
  openai: { apiBase: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  kimi: { apiBase: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu: { apiBase: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  ollama: { apiBase: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', apiKey: 'ollama' },
  custom: { apiBase: '', model: '', apiKey: '' }
};

const $ = (id) => document.getElementById(id);

init();

async function init() {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...DEFAULTS, ...(stored.settings || {}) };
  $('apiBase').value = settings.apiBase || '';
  $('apiKey').value = settings.apiKey || '';
  $('model').value = settings.model || '';
  $('autoExplain').checked = settings.autoExplain !== false;
  $('selectionButton').checked = settings.selectionButton !== false;
  $('screenshotShortcut').checked = settings.screenshotShortcut !== false;
  highlightPreset(settings.apiBase);

  $('save').addEventListener('click', save);
  $('test').addEventListener('click', test);
  $('loadModels').addEventListener('click', loadModels);
  $('toggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? '隐藏' : '显示';
  });

  $('presets').addEventListener('click', (event) => {
    const button = event.target.closest('[data-preset]');
    if (!button) return;
    const preset = PRESETS[button.dataset.preset];
    if (!preset) return;
    if (button.dataset.preset !== 'custom') {
      if (preset.apiBase !== undefined) $('apiBase').value = preset.apiBase;
      if (preset.model !== undefined) $('model').value = preset.model;
      if (preset.apiKey && !$('apiKey').value.trim()) $('apiKey').value = preset.apiKey;
    }
    for (const node of document.querySelectorAll('.preset')) {
      node.classList.toggle('active', node === button);
    }
    if (button.dataset.preset === 'custom') $('apiBase').focus();
    $('testResult').textContent = '';
    $('testResult').className = 'result';
  });

  for (const id of ['apiBase', 'model']) {
    $(id).addEventListener('input', () => highlightPreset($('apiBase').value));
  }
}

function highlightPreset(apiBase) {
  const value = String(apiBase || '').replace(/\/+$/, '');
  let matched = 'custom';
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (preset.apiBase && preset.apiBase.replace(/\/+$/, '') === value) {
      matched = key;
      break;
    }
  }
  for (const node of document.querySelectorAll('.preset')) {
    node.classList.toggle('active', node.dataset.preset === matched);
  }
}

function collect() {
  return {
    apiBase: $('apiBase').value.trim().replace(/\/+$/, ''),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    temperature: 0.4,
    autoExplain: $('autoExplain').checked,
    selectionButton: $('selectionButton').checked,
    screenshotShortcut: $('screenshotShortcut').checked
  };
}

function validate(settings) {
  if (!/^https?:\/\/.+/i.test(settings.apiBase)) {
    return '接口地址需要以 http:// 或 https:// 开头';
  }
  if (!settings.apiKey) return '请填写 API Key（本地模型可填任意词，例如 ollama）';
  if (!settings.model) return '请填写模型名';
  return '';
}

async function save() {
  const settings = collect();
  const error = validate(settings);
  if (error) {
    toast(error, true);
    return;
  }
  const stored = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({
    settings: { ...((stored && stored.settings) || {}), ...settings }
  });
  toast('设置已保存，当前网页会直接生效');
}

async function test() {
  const settings = collect();
  const error = validate(settings);
  if (error) {
    showResult(error, false);
    return;
  }
  const button = $('test');
  button.disabled = true;
  button.textContent = '测试中…';
  showResult('正在请求接口…', null);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'test', settings });
    if (response && response.ok) {
      showResult('连接成功 · ' + (response.model || settings.model) + '：' + (response.text || ''), true);
    } else {
      showResult(
        (response && response.message) || '连接失败',
        false,
        response && response.detail
      );
    }
  } catch (err) {
    showResult('测试失败：' + String(err && err.message ? err.message : err), false);
  } finally {
    button.disabled = false;
    button.textContent = '测试连接';
  }
}

async function loadModels() {
  const settings = collect();
  if (!settings.apiBase) {
    showResult('请先填写接口地址', false);
    return;
  }
  if (!settings.apiKey) {
    showResult('请先填写 API Key', false);
    return;
  }
  const button = $('loadModels');
  button.disabled = true;
  button.textContent = '获取中…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'list-models', settings });
    if (!response || !response.ok) {
      showResult((response && response.message) || '获取模型失败', false, response && response.detail);
      return;
    }
    const list = $('modelOptions');
    list.textContent = '';
    for (const id of response.models) {
      const option = document.createElement('option');
      option.value = id;
      list.appendChild(option);
    }
    const current = $('model').value.trim();
    const hint = $('modelHelp');
    const preview = response.models.slice(0, 6).join('、');
    if (current && !response.models.includes(current)) {
      hint.textContent = `接口返回 ${response.models.length} 个模型：${preview}。当前模型「${current}」不在列表中，点模型框从下拉里选一个。`;
      showResult('当前模型不在可用列表中', false);
    } else if (current) {
      hint.textContent = `接口返回 ${response.models.length} 个模型：${preview}。当前模型可用。`;
      showResult('模型列表已更新', true);
    } else {
      hint.textContent = `接口返回 ${response.models.length} 个模型：${preview}。点模型框选择。`;
      showResult('已获取模型列表，请选择模型', true);
    }
  } catch (err) {
    showResult('获取模型失败：' + String(err && err.message ? err.message : err), false);
  } finally {
    button.disabled = false;
    button.textContent = '获取模型';
  }
}

function showResult(message, ok, detail) {
  const node = $('testResult');
  node.textContent = message;
  if (detail) {
    const span = document.createElement('span');
    span.className = 'detail';
    span.textContent = detail;
    node.appendChild(span);
  }
  node.className = 'result' + (ok === true ? ' ok' : ok === false ? ' bad' : '');
}

let toastTimer = null;
function toast(message, bad) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('bad', !!bad);
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2200);
}
