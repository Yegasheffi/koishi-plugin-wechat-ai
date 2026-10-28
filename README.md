# koishi-plugin-wechat-ai

给 **wechat-onebot** 用的 Koishi 插件：直接连接网关的 OneBot 11 WebSocket，收到微信消息后调用
OpenAI 兼容的大模型 API，并把回复发回微信。

它**不是**一个通用 OneBot 适配器，而是一个独立的 AI 聊天插件：自己连网关、自己维护上下文、自己发消息。
因此不需要额外安装适配器，也不会和其它 Koishi 插件共享会话。

---

## 功能

- 连接 `wechat-onebot` 的正向 WS（token 支持 `?access_token=` 和 `Authorization`）
- 私聊直接对话；群里被 @ 或使用前缀触发，也可配置为群内全部回复
- 每个会话独立上下文，支持轮数、闲置过期、`/reset` 清空
- 每人限流，会话内串行处理，长回复自动拆分
- OpenAI 兼容接口：OpenAI、DeepSeek、Moonshot、通义、Ollama 等都可以
- 配置全部在 Koishi 控制台里完成，API Key / token 使用 secret 字段

---

## 安装

### 方式一：放进 Koishi 的 node_modules

```bash
# 本机 Koishi
cp -R koishi-plugin-wechat-ai /path/to/koishi/node_modules/koishi-plugin-wechat-ai

# Docker 里的 Koishi（容器名按实际替换）
docker cp koishi-plugin-wechat-ai zen_thompson:/koishi/node_modules/
```

然后在 `koishi.yml` 的 `plugins:` 下加：

```yaml
wechat-ai:wxai01:
  endpoint: ws://host.docker.internal:3001/onebot   # 宿主机上的 wechat-onebot
  token: ''                                         # 与 onebot11.json 一致
  selfId: wxid_你的机器人                        # 微信 wxid，用于判断 @
  baseURL: https://api.deepseek.com/v1
  apiKey: sk-你的key
  model: deepseek-chat
  groupAt: true
  privateChat: true
```

重启 Koishi（Docker：`docker restart zen_thompson`），在 Koishi 控制台的「插件配置」里就能看到
`wechat-ai` 并继续调整参数。

> 插件没有第三方依赖，`ws` 走 Koishi 自带的 `ctx.http.ws`，无需 `yarn add`。
> 如果 Koishi 在 Docker 里，`endpoint` 要用 `host.docker.internal`，不能用 `127.0.0.1`。

### 方式二：本地开发

把整个目录放到 Koishi 项目的 `node_modules/koishi-plugin-wechat-ai`，或在 Koishi 项目里：

```bash
yarn add file:/absolute/path/to/koishi-plugin-wechat-ai
```

---

## 配置

### 连接

| 字段 | 默认值 | 说明 |
|---|---|---|
| `endpoint` | `ws://127.0.0.1:3001/onebot` | wechat-onebot 的正向 WS 地址 |
| `token` | 空 | 与 `config/onebot11.json` 的 token 一致 |
| `selfId` | 空 | 机器人微信 wxid；留空会从事件里自动学习 |
| `reconnectInterval` | `5000` | 断线重连间隔（毫秒） |

### 大模型

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseURL` | `https://api.openai.com/v1` | OpenAI 兼容地址，会自动拼 `/chat/completions` |
| `apiKey` | 空 | API Key；本地 Ollama 等不需要鉴权的接口可留空 |
| `model` | `gpt-4o-mini` | 模型名 |
| `systemPrompt` | 内置 | 系统提示词 |
| `temperature` | `0.7` | 采样温度 |
| `maxTokens` | `800` | 单次最大 token |
| `timeout` | `60000` | 请求超时（毫秒） |

### 对话

| 字段 | 默认值 | 说明 |
|---|---|---|
| `privateChat` | `true` | 私聊直接回复 |
| `groupAt` | `true` | 群里被 @ 时回复 |
| `groupPrefix` | 空 | 群里以该前缀开头时触发，例如「小助手」 |
| `groupAll` | `false` | 群里所有消息都回复（慎用） |
| `maxTurns` | `8` | 每个会话保留的轮数，`0` 表示不保留上下文 |
| `sessionTTL` | `1800` | 会话闲置多久清空（秒） |
| `rateLimit` | `3` | 每人每窗口最多请求次数，`0` 不限 |
| `rateWindow` | `60` | 限流窗口（秒） |
| `commandPrefix` | `/` | 命令前缀 |
| `chunkSize` | `1500` | 单条回复最大字符数 |
| `replyError` | `true` | 出错时是否回复提示 |
| `debug` | `false` | 调试日志 |

---

## 命令

| 命令 | 说明 |
|---|---|
| `/reset`、`/clear` | 清空当前会话上下文 |
| `/help` | 显示帮助 |
| `/model` | 查看当前模型 |

命令只在「被触发」的会话里生效（私聊、群里 @、前缀或 `groupAll`）。

---

## 触发规则

- 私聊：`privateChat: true` 时所有文本消息都会回复
- 群聊：
  - `groupAt: true` 且消息里 @ 了机器人，或
  - `groupPrefix` 非空且消息以它开头，或
  - `groupAll: true`
- 机器人自己发的消息、空消息会被忽略

---

## 注意

1. **不要和另一个适配器同时接同一个网关**：如果 Koishi 已经用 OneBot 适配器接了
   `wechat-onebot`，再启用本插件会让同一条消息被处理两次（两边都可能回复）。二选一。
2. 只处理文本消息；图片、语音等会以 `[图片]`、`[语音]` 占位，不会上传给模型。
3. 上下文保存在内存里，Koishi 重启后会清空。
4. 群聊回复会直接发到群里，请先在小号/测试群验证触发条件和限流。

---

## 自测

插件目录里带了一个不依赖真实微信、真实大模型的端到端测试：

```bash
cd koishi-plugin-wechat-ai
python3 tests/plugin_test.py
```

它会启动一个假的 OneBot WS 服务和一个假的大模型 HTTP 服务，验证：
收到 @ 消息 → 调用模型 → 通过 `send_group_msg` 发出回复。
