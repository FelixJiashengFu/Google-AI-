(() => {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') || 'page';

  const MOCK_PAGE = `### 这页在讲什么
这篇文章用通俗的方式拆解了 **RAG（检索增强生成）**：先把文档切块并转成向量，提问时先检索相关片段，再交给模型组织答案。

### 关键信息
- 检索质量决定回答上限，切块方式往往比换模型更影响结果。
- 向量库只是索引，真正的瓶颈在文档清洗与召回评估。
- 上线前准备 50–100 条真实问题做回归，才能判断改动是否有效。

> 值得注意：没有评估集时，调参很容易变成凭感觉。

**一句话总结**：先把检索做对，再谈模型。`;

  const MOCK_SELECTION = `### 这句话在说什么
原文把「召回」放在模型能力之前，强调检索环节才是这类系统的上限。

### 结合上下文
在 RAG 中，模型只能基于检索到的片段作答；片段没有被召回，模型再强也补不出来。

### 关键词
- **召回（Recall）**：相关文档被检索出来的比例。
- **切块（Chunking）**：把长文档切成适合嵌入和拼进上下文的小段。

**这意味着**：优化问答效果时，应先看漏掉了哪些文档，而不是只换更大的模型。`;

  const MOCK_CHAT = `这页最值得记住的一点是：**检索质量决定 RAG 的上限**。

- 模型只能基于召回到的片段回答，漏掉的文档无法靠模型补回来。
- 切块方式和文档清洗，通常比换模型更影响最终效果。
- 做改动前先准备真实问题集，否则无法判断优化是否有效。`;

  window.chrome = {
    storage: {
      local: {
        get(keys, callback) {
          const data = {
            settings: {
              apiBase: 'https://api.openai.com/v1',
              apiKey: params.get('local') === '1' ? '' : 'sk-preview',
              model: 'preview-model',
              temperature: 0.4,
              autoExplain: true,
              selectionButton: true
            }
          };
          const promise = Promise.resolve(data);
          if (callback) callback(data);
          return promise;
        },
        set(_value, callback) {
          if (callback) callback();
          return Promise.resolve();
        }
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (!message || message.type === 'ping') {
          if (callback) callback({ ok: true });
          return;
        }
        if (message.type === 'ai') {
          const text =
            message.kind === 'selection'
              ? MOCK_SELECTION
              : message.kind === 'chat'
                ? MOCK_CHAT
                : MOCK_PAGE;
          setTimeout(() => {
            if (callback) callback({ ok: true, text, model: 'preview-model' });
          }, 450);
          return;
        }
        if (message.type === 'capture-visible-tab') {
          const canvas = document.createElement('canvas');
          canvas.width = window.innerWidth;
          canvas.height = window.innerHeight;
          const context = canvas.getContext('2d');
          const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
          gradient.addColorStop(0, '#5AC8FA');
          gradient.addColorStop(0.5, '#0A84FF');
          gradient.addColorStop(1, '#BF5AF2');
          context.fillStyle = gradient;
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = 'rgba(255,255,255,.92)';
          context.font = '600 44px -apple-system, "PingFang SC", sans-serif';
          context.fillText('截图预览', 90, 150);
          setTimeout(() => callback && callback({ ok: true, dataUrl: canvas.toDataURL('image/png') }), 120);
          return;
        }
        if (callback) callback({ ok: true });
      },
      onMessage: { addListener() {} },
      openOptionsPage() {}
    }
  };

  window.__PAGE_EXPLAINER_TEST__ = true;
  window.__PAGE_EXPLAINER_AUTOOPEN__ = mode !== 'pill';
  window.__PAGE_EXPLAINER_TEST_GOOGLE__ =
    params.get('google') === '1' || document.body.dataset.google === '1';

  window.addEventListener('load', () => {
    if (mode === 'selection') {
      setTimeout(() => {
        const paragraph = document.querySelector('.article p');
        if (paragraph && window.__pageExplainer) {
          window.__pageExplainer.explainSelection(paragraph.textContent, paragraph.textContent);
        }
      }, 700);
    }
    if (mode === 'chat') {
      setTimeout(() => {
        if (!window.__pageExplainer) return;
        window.__pageExplainer.open('chat');
        window.__pageExplainer.ask('这页最值得记住的一点是什么？');
      }, 600);
    }
    if (mode === 'pill') {
      setTimeout(() => {
        const paragraph = document.querySelector('.article p');
        if (!paragraph) return;
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }, 500);
    }
  });
})();
