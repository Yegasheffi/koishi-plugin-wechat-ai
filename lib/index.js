'use strict'

const { Schema } = require('koishi')
const { AIChatService } = require('./core')

const name = 'wechat-ai'

const Config = Schema.intersect([
  Schema.object({
    endpoint: Schema.string()
      .default('ws://127.0.0.1:3001/onebot')
      .description('wechat-onebot 的正向 WebSocket 地址。'),
    token: Schema.string()
      .role('secret')
      .description('与 config/onebot11.json 里的 token 保持一致，留空则不校验。'),
    selfId: Schema.string()
      .default('')
      .description('机器人微信 wxid，用来判断群里是否 @ 了机器人；留空则从事件里自动学习。'),
    reconnectInterval: Schema.natural()
      .min(1000)
      .default(5000)
      .description('断线重连间隔（毫秒）。'),
  }).description('连接设置'),

  Schema.object({
    baseURL: Schema.string()
      .default('https://api.openai.com/v1')
      .description('OpenAI 兼容接口地址，例如 https://api.deepseek.com/v1。'),
    apiKey: Schema.string()
      .role('secret')
      .description('大模型 API Key。'),
    model: Schema.string()
      .default('gpt-4o-mini')
      .description('模型名称。'),
    systemPrompt: Schema.string()
      .role('textarea')
      .default('你是一个友好、简洁的微信聊天助手。回答尽量口语化，不要使用 Markdown。')
      .description('系统提示词。'),
    temperature: Schema.number()
      .min(0)
      .max(2)
      .default(0.7)
      .description('采样温度。'),
    maxTokens: Schema.natural()
      .default(800)
      .description('单次回复最大 token 数。'),
    timeout: Schema.natural()
      .min(1000)
      .default(60000)
      .description('请求超时（毫秒）。'),
  }).description('大模型设置'),

  Schema.object({
    privateChat: Schema.boolean()
      .default(true)
      .description('私聊消息是否直接回复。'),
    groupAt: Schema.boolean()
      .default(true)
      .description('群里被 @ 时是否回复。'),
    groupPrefix: Schema.string()
      .default('')
      .description('群里以该前缀开头时触发，例如「小助手」；留空关闭。'),
    groupAll: Schema.boolean()
      .default(false)
      .description('群里所有消息都回复（谨慎开启，容易刷屏）。'),
    maxTurns: Schema.natural()
      .default(8)
      .description('每个会话保留的对话轮数（0 表示不保留上下文）。'),
    sessionTTL: Schema.natural()
      .default(1800)
      .description('会话闲置多久后清空上下文（秒）。'),
    rateLimit: Schema.natural()
      .default(3)
      .description('每人每窗口最多请求次数（0 表示不限制）。'),
    rateWindow: Schema.natural()
      .default(60)
      .description('限流窗口（秒）。'),
    commandPrefix: Schema.string()
      .default('/')
      .description('内置命令前缀，支持 reset / help / model。'),
    chunkSize: Schema.natural()
      .min(200)
      .default(1500)
      .description('单条回复的最大字符数，超出会拆成多条发送。'),
    replyError: Schema.boolean()
      .default(true)
      .description('调用模型失败时是否在聊天里回复提示。'),
    debug: Schema.boolean()
      .default(false)
      .description('输出调试日志。'),
  }).description('对话设置'),
])

function apply(ctx, config) {
  const logger = ctx.logger(name)
  const service = new AIChatService({
    config,
    logger,
    createSocket: async (url, headers) => {
      if (ctx.http && typeof ctx.http.ws === 'function') {
        return ctx.http.ws(url, { headers })
      }
      if (typeof WebSocket !== 'undefined') return new WebSocket(url)
      throw new Error('当前运行环境没有可用的 WebSocket 实现')
    },
    request: async ({ url, headers, body, timeout }) => {
      if (ctx.http && typeof ctx.http.post === 'function') {
        return await ctx.http.post(url, body, { headers, timeout })
      }
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
      if (!response.ok) throw new Error(`大模型接口 HTTP ${response.status}`)
      return await response.json()
    },
  })

  ctx.on('dispose', () => service.dispose())
  service.start()
  logger.info(`已启用：${config.endpoint} -> ${config.model} @ ${config.baseURL}`)
}

module.exports = {
  name,
  Config,
  apply,
  inject: ['http'],
}
module.exports.default = module.exports
