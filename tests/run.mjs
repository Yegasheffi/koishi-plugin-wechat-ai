import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { AIChatService } = require('../lib/core.js')

const wsPort = Number(process.env.WS_PORT)
const llmPort = Number(process.env.LLM_PORT)

const service = new AIChatService({
  config: {
    endpoint: `ws://127.0.0.1:${wsPort}/onebot`,
    token: '',
    selfId: 'wxid_bot',
    baseURL: `http://127.0.0.1:${llmPort}/v1`,
    apiKey: 'test-key',
    model: 'test-model',
    systemPrompt: 'test-system-prompt',
    groupAt: true,
    privateChat: true,
    maxTurns: 2,
    rateLimit: 0,
  },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  createSocket: async (url) => new WebSocket(url),
  request: async ({ url, headers, body }) => {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  },
})

service.start()
setTimeout(() => {
  service.dispose()
  process.exit(0)
}, 6000)
