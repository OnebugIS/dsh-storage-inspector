/**
 * lib/index.js —— Host 侧
 *
 * 两个入口共用一个数据层（lib/scan.js）：
 *   1) agent 工具 `storage_report` —— 对话里问「DSH 占多少空间」
 *   2) HTTP 路由 `/api/storage/report` —— 设置页「存储」分区渲染用
 *
 * 硬约束（2026-10-27 事故后写死）：
 *   - 不 import 任何 `@deepseek-ai/*`：`link:` 安装的包解析不到外部包，
 *     旧写法会报 `does not provide an export named 'CallId'`；
 *   - 工具用**裸对象**注册（parameters 是完整 JSON Schema，output 必须给
 *     schema + render，缺一个都注册不上）；
 *   - 路由 / 工具都用 ctx.effect 托管，卸载时可回收；
 *   - 路由只接受本机 loopback 请求（同源 + 非代理头），照 dsh-usage 的栅栏语义重写。
 */
import { scan, toSummary } from './scan.js'

export const name = 'dsh-storage-inspector'

/** 路由只需要 webServer；tools 走可选注入，缺了也不影响路由。 */
export const inject = ['webServer']

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
}

function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(JSON.stringify(body))
}

/** IPv4 127/8（四段十进制，首段 127）。 */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** socket 地址是否属于 loopback（127/8、::1、IPv4-mapped）。 */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = String(address).toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Host 头里的主机名是否 loopback。 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** 反向代理头：出现即说明请求不是从本机直连来的。 */
function isProxiedRequest(request) {
  return (
    request.headers['cf-connecting-ip'] !== undefined ||
    request.headers['x-forwarded-for'] !== undefined
  )
}

/**
 * 请求级信任栅栏：socket 是 loopback **且** Host 是 loopback **且** 不是代理转发
 * **且** 浏览器同源标记不是 cross-site **且** Origin（若有）同源。
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  if (isProxiedRequest(request)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 解析并校验配置：未知键直接报错，不静默忽略。 */
const CONFIG_KEYS = new Set(['cacheTtlMs', 'timeoutMs'])

export function resolveConfig(config) {
  const input = config ?? {}
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`dsh-storage-inspector: unknown config key "${key}"`)
  }
  const cacheTtlMs = input.cacheTtlMs ?? 300_000
  const timeoutMs = input.timeoutMs ?? 10_000
  for (const [key, value] of [
    ['cacheTtlMs', cacheTtlMs],
    ['timeoutMs', timeoutMs],
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`dsh-storage-inspector: config "${key}" must be a finite non-negative number`)
    }
  }
  if (timeoutMs <= 0) {
    throw new Error('dsh-storage-inspector: config "timeoutMs" must be greater than 0')
  }
  return { cacheTtlMs, timeoutMs }
}

/** 工具的模型侧输出 schema（保持窄，别把整份报告塞进 schema）。 */
const REPORT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: '扫描是否成功' },
    root: { type: 'string', description: '被扫描的 DSH 根目录' },
    totals: {
      type: 'object',
      additionalProperties: true,
      description: '总量：physical（物理块口径，与 du/Finder 一致）、logical（st_size 之和）、files、dirs',
    },
    reclaimableBytes: { type: 'number', description: '可回收字节（不含禁止删除的运行时）' },
    advice: { type: 'array', items: { type: 'object' }, description: '三层建议：safe / caution / forbidden' },
    modules: { type: 'array', items: { type: 'object' }, description: '按模块的占用' },
  },
  required: ['ok', 'totals'],
}

export const apply = (ctx, config) => {
  const options = resolveConfig(config)
  const scanOptions = { cacheTtlMs: options.cacheTtlMs, timeoutMs: options.timeoutMs }

  const disposeRoute = ctx.webServer.register({
    kind: 'exact',
    path: '/api/storage/report',
    handler: async (req, res) => {
      // 只读端点：只接受 GET/HEAD，其它方法直接拒绝，避免被当成写入入口试探
      if (typeof req.method === 'string' && req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET, HEAD' })
        return
      }
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      try {
        let force = false
        try {
          const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
          force = query.get('force') === '1' || query.get('force') === 'true'
        } catch {
          // Malformed request URLs simply use the normal cached path.
        }
        const report = await scan(force ? { ...scanOptions, force: true } : scanOptions)
        writeJson(res, 200, report, { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  })
  ctx.effect(() => () => disposeRoute(), 'dsh-storage-inspector: route')

  ctx.inject(['tools'], (tctx) => {
    tctx.effect(
      () =>
        tctx.tools.register({
          name: 'storage_report',
          description:
            'DSH 磁盘占用体检：总量、按模块占用、最大文件、可回收清单与原因。只读、纯本地，不删任何东西。',
          parameters: {
            type: 'object',
            properties: {
              detail: {
                type: 'string',
                enum: ['summary', 'full'],
                description: 'summary（默认）给总量+模块+建议；full 追加最大文件与缓存明细。',
              },
            },
            additionalProperties: false,
          },
          output: {
            schema: REPORT_OUTPUT_SCHEMA,
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args) => {
            const report = await scan(scanOptions)
            const detail = args && typeof args === 'object' ? args.detail : undefined
            return detail === 'full' ? report : toSummary(report)
          },
        }),
      'dsh-storage-inspector: storage_report tool',
    )
  })
}
