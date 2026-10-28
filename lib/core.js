'use strict'

/**
 * 与 Koishi 解耦的核心实现：
 *   - 连接 wechat-onebot 的正向 WS（OneBot 11）
 *   - 按私聊 / @ / 前缀等规则触发
 *   - 维护每个会话的上下文
 *   - 调用 OpenAI 兼容的 /chat/completions
 *   - 通过 OneBot action 回复消息
 *
 * index.js 只负责把它接到 Koishi 的 ctx / Schema 上。
 */

const DEFAULTS = {
  endpoint: 'ws://127.0.0.1:3001/onebot',
  token: '',
  selfId: '',
  reconnectInterval: 5000,

  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  systemPrompt: '你是一个友好、简洁的微信聊天助手。回答尽量口语化，不要使用 Markdown。',
  temperature: 0.7,
  maxTokens: 800,
  timeout: 60000,

  privateChat: true,
  groupAt: true,
  groupPrefix: '',
  groupAll: false,

  maxTurns: 8,
  sessionTTL: 1800,
  rateLimit: 3,
  rateWindow: 60,

  replyError: true,
  commandPrefix: '/',
  chunkSize: 1500,
  debug: false,
}

function normalizeConfig(input) {
  const config = { ...DEFAULTS, ...(input || {}) }
  config.selfId = String(config.selfId || '')
  config.token = String(config.token || '')
  config.endpoint = String(config.endpoint || '')
  config.baseURL = String(config.baseURL || '')
  config.maxTurns = Number(config.maxTurns) || 0
  config.rateLimit = Number(config.rateLimit) || 0
  config.chunkSize = Math.max(200, Number(config.chunkSize) || 1500)
  config.timeout = Math.max(1000, Number(config.timeout) || 60000)
  return config
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把 OneBot 的 message（数组或 CQ 串）拍平成文本，并判断是否 @ 了机器人。 */
function extractMessage(message, selfId) {
  let text = ''
  let atSelf = false
  if (typeof message === 'string') {
    if (selfId) {
      atSelf = new RegExp(`\\[CQ:at,qq=${escapeRegExp(selfId)}(?:,[^\\]]*)?\\]`).test(message)
    }
    text = message.replace(/\[CQ:[^\]]+\]/g, '')
    return { text, atSelf }
  }
  if (!Array.isArray(message)) return { text, atSelf }
  for (const segment of message) {
    if (!segment || typeof segment !== 'object') continue
    if (segment.type === 'text') {
      text += segment.data?.text ?? ''
    } else if (segment.type === 'at') {
      const qq = String(segment.data?.qq ?? '')
      if (selfId && qq === String(selfId)) {
        atSelf = true
      } else if (qq) {
        text += '@' + (segment.data?.name || qq)
      }
    } else if (segment.type === 'image') {
      text += '[图片]'
    } else if (segment.type === 'record') {
      text += '[语音]'
    }
  }
  return { text, atSelf }
}

/** 按长度切分回复，微信单条消息不宜过长。 */
function splitText(text, size) {
  const value = String(text ?? '')
  if (!value) return []
  if (value.length <= size) return [value]
  const parts = []
  let rest = value
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size)
    if (cut < size * 0.5) cut = size
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) parts.push(rest)
  return parts
}

function extractContent(data) {
  const message = data?.choices?.[0]?.message
  let content = message?.content
  if (Array.isArray(content)) {
    content = content
      .map((part) => (typeof part === 'string' ? part : part?.text || part?.content || ''))
      .join('')
  }
  if (typeof content !== 'string') return ''
  return content.trim()
}

class AIChatService {
  constructor(options) {
    this.config = normalizeConfig(options.config)
    this.logger = options.logger || console
    this.createSocket = options.createSocket
    this.request = options.request

    this.selfId = this.config.selfId
    this.ws = null
    this.closed = false
    this.reconnectTimer = null
    this.cleanupTimer = null
    this.pending = new Map()
    this.histories = new Map()
    this.rates = new Map()
    this.queues = new Map()
    this.sequence = 0
  }

  // -- 日志 --------------------------------------------------------------
  _log(level, ...args) {
    const logger = this.logger || console
    const fn = logger[level] || logger.info || console.log
    try {
      fn.apply(logger, args)
    } catch (_) {
      /* 日志失败不影响主流程 */
    }
  }

  info(...args) {
    this._log('info', ...args)
  }

  warn(...args) {
    this._log('warn', ...args)
  }

  error(...args) {
    this._log('error', ...args)
  }

  debug(...args) {
    if (this.config.debug) this._log('debug', ...args)
  }

  // -- 生命周期 ----------------------------------------------------------
  start() {
    if (this.closed) return
    if (!this.config.endpoint) {
      this.error('未配置 endpoint，插件不会连接')
      return
    }
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 1000)
      this.cleanupTimer.unref?.()
    }
    this.connect()
  }

  dispose() {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.reconnectTimer = null
    this.cleanupTimer = null
    for (const [echo, item] of this.pending) {
      clearTimeout(item.timer)
      item.reject(new Error('插件已停止'))
      this.pending.delete(echo)
    }
    try {
      this.ws?.close()
    } catch (_) {
      /* ignore */
    }
    this.ws = null
  }

  socketUrl() {
    const url = new URL(this.config.endpoint)
    if (this.config.token) url.searchParams.set('access_token', this.config.token)
    return url.toString()
  }

  async connect() {
    if (this.closed) return
    try {
      const headers = { 'User-Agent': 'koishi-wechat-ai/1.0' }
      if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`
      const socket = await this.createSocket(this.socketUrl(), headers)
      if (this.closed) {
        try {
          socket.close()
        } catch (_) {
          /* ignore */
        }
        return
      }
      this.ws = socket
      this.bindSocket(socket)
      this.info(`正在连接 ${this.config.endpoint}`)
    } catch (error) {
      this.warn(`连接失败：${error.message}，${this.config.reconnectInterval}ms 后重试`)
      this.scheduleReconnect()
    }
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, Math.max(1000, this.config.reconnectInterval))
    this.reconnectTimer.unref?.()
  }

  bindSocket(socket) {
    const onMessage = (data) => this.onPayload(data)
    if (typeof socket.on === 'function') {
      socket.on('open', () => this.info('连接已建立'))
      socket.on('message', onMessage)
      socket.on('close', () => this.onClose(socket))
      socket.on('error', (error) => this.warn(`WebSocket 错误：${error?.message || error}`))
      return
    }
    if (typeof socket.addEventListener === 'function') {
      socket.addEventListener('open', () => this.info('连接已建立'))
      socket.addEventListener('message', (event) => onMessage(event.data))
      socket.addEventListener('close', () => this.onClose(socket))
      socket.addEventListener('error', () => this.warn('WebSocket 错误'))
      return
    }
    this.warn('未知的 WebSocket 实现，无法绑定事件')
  }

  onClose(socket) {
    // 旧连接关闭时如果已经建立了新连接，忽略这次回调
    if (socket && this.ws && this.ws !== socket) return
    this.ws = null
    if (this.closed) return
    this.warn('连接已断开，准备重连')
    this.scheduleReconnect()
  }

  // -- OneBot 通信 -------------------------------------------------------
  onPayload(raw) {
    let payload
    try {
      const text = typeof raw === 'string' ? raw : raw?.toString?.() ?? String(raw)
      payload = JSON.parse(text)
    } catch (error) {
      this.debug(`忽略无法解析的数据：${error.message}`)
      return
    }
    if (!payload || typeof payload !== 'object') return

    const echo = payload.echo
    if (echo && this.pending.has(echo)) {
      const item = this.pending.get(echo)
      this.pending.delete(echo)
      clearTimeout(item.timer)
      if (payload.retcode === 0 || payload.status === 'ok') {
        item.resolve(payload.data)
      } else {
        item.reject(new Error(payload.wording || payload.message || `retcode ${payload.retcode}`))
      }
      return
    }

    if (payload.post_type === 'message') this.onMessageEvent(payload)
  }

  sendAction(action, params, timeout = 10000) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('尚未连接到 wechat-onebot'))
    }
    const echo = `wechat-ai-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`动作 ${action} 超时`))
      }, timeout)
      timer.unref?.()
      this.pending.set(echo, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(error)
      }
    })
  }

  // -- 消息处理 ----------------------------------------------------------
  onMessageEvent(event) {
    const selfId = this.selfId || String(event.self_id || '')
    if (!this.selfId && selfId) this.selfId = selfId

    const userId = String(event.user_id || event.sender?.user_id || '')
    if (!userId) return
    if (selfId && userId === selfId) return

    const chatType = event.message_type === 'group' ? 'group' : 'private'
    const chatId = String(chatType === 'group' ? event.group_id : userId)
    if (!chatId) return

    const { text, atSelf } = extractMessage(event.message, this.selfId)
    let body = text.trim()
    if (!body) return

    const prefix = String(this.config.groupPrefix || '')
    let triggered
    if (chatType === 'private') {
      triggered = Boolean(this.config.privateChat)
    } else {
      triggered =
        Boolean(this.config.groupAll) ||
        (Boolean(this.config.groupAt) && atSelf) ||
        (Boolean(prefix) && body.startsWith(prefix))
    }
    if (!triggered) return

    if (chatType === 'group' && prefix && body.startsWith(prefix)) {
      body = body.slice(prefix.length).trim()
    }
    if (!body) return

    const command = this.parseCommand(body)
    const nickname = event.sender?.card || event.sender?.nickname || userId
    const key = `${chatType}:${chatId}`

    this.enqueue(key, () =>
      this.handleMessage({
        key,
        chatType,
        chatId,
        userId,
        nickname,
        text: body,
        command,
      }),
    )
  }

  parseCommand(text) {
    const prefix = String(this.config.commandPrefix || '/')
    if (!prefix || !text.startsWith(prefix)) return null
    const [name, ...args] = text.slice(prefix.length).trim().split(/\s+/)
    if (!name) return null
    return { name: name.toLowerCase(), args: args.join(' ') }
  }

  enqueue(key, task) {
    const previous = this.queues.get(key) || Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(task)
      .catch((error) => this.error(`处理消息失败：${error?.stack || error}`))
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key)
      })
    this.queues.set(key, next)
  }

  async handleMessage(context) {
    const { key, chatType, chatId, userId, text, command } = context

    if (command) {
      const handled = await this.handleCommand(command, { key, chatType, chatId })
      if (handled) return
    }

    if (this.config.rateLimit > 0 && !this.allow(userId)) {
      await this.reply(chatType, chatId, '请求有点频繁，请稍后再试。')
      return
    }

    try {
      const history = this.getHistory(key)
      const messages = [
        { role: 'system', content: this.config.systemPrompt },
        ...history.messages,
        { role: 'user', content: text },
      ]
      const answer = await this.complete(messages)
      history.messages.push({ role: 'user', content: text }, { role: 'assistant', content: answer })
      history.updated = Date.now()
      this.trimHistory(history)
      await this.reply(chatType, chatId, answer)
    } catch (error) {
      this.error(`调用模型失败：${error?.stack || error}`)
      if (this.config.replyError) {
        await this.reply(chatType, chatId, '抱歉，AI 服务暂时不可用，请稍后再试。')
      }
    }
  }

  async handleCommand(command, { key, chatType, chatId }) {
    switch (command.name) {
      case 'reset':
      case 'clear':
        this.histories.delete(key)
        await this.reply(chatType, chatId, '已清空当前会话的上下文。')
        return true
      case 'help':
        await this.reply(
          chatType,
          chatId,
          [
            '可用命令：',
            `${this.config.commandPrefix}reset  清空当前会话上下文`,
            `${this.config.commandPrefix}help   显示帮助`,
            `私聊直接说话；群里 ${this.config.groupAt ? '@我 ' : ''}${this.config.groupPrefix ? `或以「${this.config.groupPrefix}」开头` : ''}即可对话。`,
            `当前模型：${this.config.model}`,
          ].join('\n'),
        )
        return true
      case 'model':
        await this.reply(chatType, chatId, `当前模型：${this.config.model}`)
        return true
      default:
        return false
    }
  }

  allow(userId) {
    const now = Date.now()
    const windowMs = Math.max(10, this.config.rateWindow || 60) * 1000
    const history = (this.rates.get(userId) || []).filter((time) => now - time < windowMs)
    if (history.length >= this.config.rateLimit) {
      this.rates.set(userId, history)
      return false
    }
    history.push(now)
    this.rates.set(userId, history)
    return true
  }

  getHistory(key) {
    const ttl = Math.max(0, this.config.sessionTTL) * 1000
    const current = this.histories.get(key)
    if (!current || (ttl > 0 && Date.now() - current.updated > ttl)) {
      const fresh = { messages: [], updated: Date.now() }
      this.histories.set(key, fresh)
      return fresh
    }
    return current
  }

  trimHistory(history) {
    const limit = Math.max(0, this.config.maxTurns) * 2
    if (limit <= 0) {
      history.messages = []
    } else if (history.messages.length > limit) {
      history.messages = history.messages.slice(-limit)
    }
  }

  async complete(messages) {
    if (!this.config.baseURL) throw new Error('未配置 baseURL')
    const base = this.config.baseURL.replace(/\/+$/, '')
    const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
    const headers = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`
    const body = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      stream: false,
    }
    this.debug(`请求模型 ${this.config.model}`)
    const data = await this.request({ url, headers, body, timeout: this.config.timeout })
    const content = extractContent(data)
    if (!content) throw new Error('模型没有返回内容')
    return content
  }

  async reply(chatType, chatId, text) {
    if (!text) return
    const action = chatType === 'group' ? 'send_group_msg' : 'send_private_msg'
    const field = chatType === 'group' ? 'group_id' : 'user_id'
    for (const part of splitText(text, this.config.chunkSize)) {
      try {
        await this.sendAction(action, {
          [field]: chatId,
          message: [{ type: 'text', data: { text: part } }],
        })
      } catch (error) {
        this.error(`发送消息失败：${error?.message || error}`)
        return
      }
    }
  }

  cleanup() {
    const ttl = Math.max(0, this.config.sessionTTL) * 1000
    if (ttl > 0) {
      const now = Date.now()
      for (const [key, history] of this.histories) {
        if (now - history.updated > ttl * 2) this.histories.delete(key)
      }
    }
    const windowMs = Math.max(10, this.config.rateWindow || 60) * 1000
    const now = Date.now()
    for (const [userId, times] of this.rates) {
      const next = times.filter((time) => now - time < windowMs)
      if (next.length) this.rates.set(userId, next)
      else this.rates.delete(userId)
    }
  }
}

module.exports = {
  AIChatService,
  DEFAULT_CONFIG: DEFAULTS,
  extractMessage,
  splitText,
  extractContent,
  normalizeConfig,
}
