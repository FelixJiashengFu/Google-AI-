# dadada

一个 Chrome 扩展：在任意网页右下角悬浮一个「解」气泡，点开就能总结本页、划词解释、围绕页面追问。对 Google 搜索结果页会额外给出结果速览。

它运行在 Chrome 里，不依赖 ZCode 进程。讲解能力来自你填写的 OpenAI 兼容接口；不填也能使用本地摘要、页面结构、关键词和「复制正文」。

## 下载

**[⬇ 下载完整扩展包 dadada.zip](https://github.com/FelixJiashengFu/dadada/releases/latest/download/dadada.zip)** · [查看版本](https://github.com/FelixJiashengFu/dadada/releases/latest)

下载后解压，就能获得完整的 `dadada` 文件夹。无需 Git、Node.js 或编译，也不用逐个下载文件。安装方法见下方「安装」，压缩包内也附有 `INSTALL.txt`。

## 功能

- **悬浮球 + 面板**：可拖动，位置会记住；`Alt+Shift+E`（macOS 为 `⌥⇧E`）开关面板。
- **本页讲解**：提取正文，统计字数与阅读时间，生成 AI 概览；没配置接口时显示本地抽取式摘要和关键词。
- **页面结构**：列出标题，点击可跳转并高亮对应位置。
- **划词讲解**：选中 4 个字以上，选区上方浮出「讲解」按钮；解释含义、术语和上下文。也支持右键菜单「讲解选中内容」。
- **围绕页面问答**：在「问答」标签里连续追问，自动带上当前页正文。
- **Google 搜索结果速览**：识别搜索页，列出可见结果的标题、来源和摘要；AI 会说明这批结果在回答什么、来源差异。
- **双击空格截图**：连按两下空格冻结屏幕，拖动框选后自动复制，并切到 ChatGPT 尝试粘贴；`Alt+Shift+S` 随时可用。
- **本地模式**：没有 API Key 也能用摘要、结构、关键词；「复制正文」可以直接把页面内容带去 ZCode 里提问。

## 安装

1. 点击上方的 **「下载完整扩展包 dadada.zip」**，保存到电脑。
2. **先解压 ZIP**：Windows 右键压缩包 →「全部解压」；macOS 双击压缩包。把解压后的 `dadada` 文件夹放在一个固定位置。
3. 在 Chrome 地址栏输入 `chrome://extensions`，打开右上角的 **「开发者模式」**。
4. 点 **「加载已解压的扩展程序」**，选择解压后的 **`dadada` 文件夹**。选中的这一层必须直接包含 `manifest.json`，不要选择 ZIP 文件或 `icons`、`test` 子文件夹。
5. 出现「dadada」扩展卡片后，把扩展固定到工具栏，并刷新要使用的网页。

```text
dadada/                 ← 第 4 步选择这一层
├── manifest.json       ← 这里必须看得到这个文件
├── background.js
├── content.js
├── icons/
├── INSTALL.txt
└── ...
```

安装后请保留这个文件夹；浏览器会继续从中读取扩展文件。这个 ZIP 通过开发者模式加载，不能双击 ZIP 自动安装。

如果通过 GitHub 绿色 **Code → Download ZIP** 下载了整个仓库，解压后选择直接包含 `manifest.json` 的 `dadada-main` 文件夹，也可以安装。

Edge 使用 `edge://extensions`，同样先打开开发者模式，再选择「加载解压缩的扩展」。

参考：[Chrome 官方本地加载扩展说明](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)。

## 连接 AI（推荐）

点扩展图标 →「设置」，或点悬浮面板底部的模式文字。

1. 选一个预设（OpenAI / DeepSeek / Kimi / 智谱 / Ollama 本地），或点「自定义」。
2. 填写接口地址、API Key、模型名。接口地址填到 `/v1` 即可，扩展会自动补 `/chat/completions`；也可以直接填完整的 `.../chat/completions`。
3. 点「测试连接」，看到「连接成功」后保存。

填完接口地址和 Key 后，可以点「获取模型」直接拉取这个接口的模型列表；如果模型名写错（例如网关没有 `deepseek-chat`），会返回 HTTP 400，从下拉列表里换一个即可。

支持任何 OpenAI Chat Completions 兼容接口：

| 服务 | 接口地址 | 模型名示例 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b`，Key 随意填 `ollama` |
| LM Studio | `http://127.0.0.1:1234/v1` | 按加载的模型填写，Key 随意填 |

模型名会随服务商更新，实际以服务商文档为准。部分推理模型不接受 `max_tokens` 或 `temperature`，遇到 400 时换用普通对话模型。

## 使用

- **打开面板**：点悬浮球，或按 `Alt+Shift+E`，或点扩展图标里的「打开讲解面板」。
- **本页**：查看统计、AI 讲解、结果速览和页面结构。已连接 AI 且开启「自动讲解」时，打开面板会自动生成一次讲解。
- **划词**：在网页上选中文字，点浮出的「讲解」。面板会切到「划词」标签。
- **问答**：切到「问答」输入问题；`Enter` 发送，`Shift+Enter` 换行。
- **右键菜单**：选中文字后右键「讲解选中内容」，或在页面空白处右键「讲解这个页面」。
- **本地模式**：未配置 AI 时，点「复制正文」把标题、网址和正文复制到剪贴板，再粘贴给 ZCode 或其他助手。

### 截图并粘贴到 ChatGPT

1. 在页面空白处**连续按两下空格**，或按 `Alt+Shift+S`（macOS 为 `⌥⇧S`）。
2. 屏幕冻结后，鼠标位置会出现十字准星；按住拖动框选区域，`Esc` 取消。
3. 松开鼠标后，截图会复制到剪贴板，并自动切到你已打开的 ChatGPT 标签页（`chatgpt.com`）尝试粘贴。
4. 如果输入框没有出现图片，直接按 `⌘V` / `Ctrl+V`；没有打开 ChatGPT 时会自动新开一个标签页。

截图只在你触发时捕获当前可见页面，不会在后台自动截屏。若不想用双击空格，可在设置里关闭；`Alt+Shift+S` 仍然可用。

## 权限与隐私

- 页面正文只在你点击「开始讲解 / 讲解 / 发送问题」时，发送到你填写的接口，不会经过其他服务器。
- API Key 保存在本机 Chrome 的 `chrome.storage.local`，不参与 Chrome 同步。
- 扩展申请了「读取和更改所有网站上的数据」，因为悬浮球需要出现在任意页面；它不会在后台自动上传页面内容。
- 本地摘要、页面结构、关键词完全在浏览器里计算。

## 不支持的页面

- `chrome://`、`edge://`、扩展商店（Chrome Web Store）等浏览器内部页面禁止扩展注入。
- Chrome 内置 PDF 阅读器里不能划词；可以改用 PDF 插件或下载后在别处阅读。
- `file://` 页面需要在扩展详情里打开「允许访问文件网址」。
- 跨域 iframe 里的文字不会被划词捕获，面板只处理顶层页面。

## 常见问题

**看不到悬浮球？**
刷新页面；确认扩展已启用；在扩展详情里检查「网站访问权限」没有被设成仅点击时。安装或更新扩展后，旧标签页需要刷新。

**提示 401 / 404 / 429？**
401 是 Key 无效或过期；404 多为接口地址或模型名不对；429 是频率或额度限制。面板会显示服务端返回的详细原因。

**Ollama 连不上？**
确认 `ollama serve` 正在运行，并允许扩展来源的跨域请求，例如启动时设置 `OLLAMA_ORIGINS="chrome-extension://*"`。测试连接能看到「连接成功」即可。

**截图后 ChatGPT 输入框里没有图片？**
合成粘贴在部分 ChatGPT 版本里会被忽略。截图已经复制到剪贴板，直接按 `⌘V` / `Ctrl+V` 即可；也可以先点一下 ChatGPT 的输入框再粘贴。首次使用需要先登录 ChatGPT。

**双击空格没有反应？**
焦点在输入框、按钮或可编辑区域里时不会触发，避免影响正常打字；用 `Alt+Shift+S` 可以在任何位置截图。也可以在设置里检查「双击空格开始截图」是否开启。

**为什么面板样式没有出现在某些网站？**
面板样式使用 Shadow DOM 和构造样式表，不依赖页面的 `style-src` 许可；如果整块界面完全不出现，多半是页面禁止注入或脚本被拦截。

**会消耗多少 token？**
只在点击讲解或提问时请求，默认不流式、不带历史网页内容之外的上下文。关闭「打开面板时自动讲解本页」可以避免每次打开都请求一次。

## 文件结构

```
dadada/
├── manifest.json        # MV3 清单
├── background.js        # service worker：AI 请求、错误映射、右键菜单
├── content.js           # 悬浮球/面板、页面提取、本地摘要、划词
├── popup.html/js        # 工具栏弹窗
├── options.html/js      # 设置页
├── icons/               # 扩展图标
└── test/                # 本地预览页与 chrome API 桩，不参与线上逻辑
```

## 本地预览（开发）

```bash
cd dadada
python3 -m http.server 8765
```

- 文章页：`http://127.0.0.1:8765/test/article.html?mode=page`
- 划词：`?mode=selection`
- 问答：`?mode=chat`
- 划词按钮：`?mode=pill`
- 截图源页面：`http://127.0.0.1:8765/test/shot-source.html`
- ChatGPT 模拟页：`http://127.0.0.1:8765/test/chatgpt-mock.html`
- Google 结果页：`http://127.0.0.1:8765/test/google.html?mode=page`
- 严格 CSP：`http://127.0.0.1:8765/test/csp.html?mode=page`
- 设置页：`http://127.0.0.1:8765/test/options-preview.html`
- 弹窗：`http://127.0.0.1:8765/test/popup-preview.html`

预览页通过 `test/stub.js` 模拟 `chrome.storage` 和 `chrome.runtime`，并返回固定的示例讲解；不会发起真实请求。
