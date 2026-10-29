import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, isLoopbackRequest, resolveConfig } from '../lib/index.js'
import { clearScanCache } from '../lib/scan.js'

/** 最小可用 fixture：够跑一次扫描，且含运行时目录以触发禁止项。 */
async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-host-'))
  const mk = async (rel, bytes) => {
    const abs = join(root, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, 'x'.repeat(bytes))
  }
  await mk('sessions/s.json', 128)
  await mk('dsh-runtimes/node/bin', 256)
  await mk('cache/c.bin', 64)
  return root
}

/** 捕获 register 结果的假 context（不依赖真实 cordis）。 */
function makeContext() {
  const captured = { routes: [], tools: [], effects: [] }
  const ctx = {
    webServer: {
      register(route) {
        captured.routes.push(route)
        return () => {
          captured.routes = captured.routes.filter((r) => r !== route)
        }
      },
    },
    effect(fn, label) {
      captured.effects.push(label)
      return fn()
    },
    inject(names, callback) {
      if (!names.includes('tools')) return
      callback({
        effect(fn) {
          return fn()
        },
        tools: {
          register(definition) {
            captured.tools.push(definition)
            return () => {}
          },
        },
      })
    },
  }
  return { ctx, captured }
}

function makeRes() {
  const out = { status: 0, headers: {}, raw: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers || {}
    },
    end(body) {
      out.raw = typeof body === 'string' ? body : String(body ?? '')
    },
  }
}

function makeReq(overrides = {}) {
  const headers = {
    host: '127.0.0.1:57871',
    ...(overrides.headers || {}),
  }
  return {
    socket: { remoteAddress: '127.0.0.1' },
    headers,
    ...overrides,
    ...(overrides.headers ? { headers } : {}),
  }
}

async function withRouteFixture(fn) {
  const root = await makeFixture()
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = root
  clearScanCache()
  try {
    const { ctx, captured } = makeContext()
    apply(ctx, { cacheTtlMs: 0 })
    await fn({ root, captured })
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    clearScanCache()
    await rm(root, { recursive: true, force: true })
  }
}

test('apply：注册一条 exact 路由和一个工具', async () => {
  await withRouteFixture(async ({ captured }) => {
    assert.equal(captured.routes.length, 1)
    assert.equal(captured.routes[0].kind, 'exact')
    assert.equal(captured.routes[0].path, '/api/storage/report')
    assert.equal(typeof captured.routes[0].handler, 'function')

    assert.equal(captured.tools.length, 1)
    assert.equal(captured.tools[0].name, 'storage_report')
  })
})

test('工具定义符合注册契约：完整 JSON Schema + output.schema + output.render', async () => {
  await withRouteFixture(async ({ captured }) => {
    const def = captured.tools[0]
    assert.equal(def.parameters.type, 'object')
    assert.deepEqual(def.parameters.properties.detail.enum, ['summary', 'full'])
    assert.equal(def.parameters.additionalProperties, false)
    assert.equal(def.output.schema.type, 'object')
    assert.deepEqual(def.output.schema.required, ['ok', 'totals'])
    assert.equal(typeof def.output.render, 'function')
    const rendered = def.output.render({}, { ok: true, totals: { physical: 1 } })
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /"ok":true/)
    assert.equal(typeof def.execute, 'function')
    // 描述要短：常驻上下文，别写成长文
    assert.ok(def.description.length <= 120, `description 太长: ${def.description.length}`)
  })
})

test('工具执行：summary 不带最大文件，full 带', async () => {
  await withRouteFixture(async ({ captured }) => {
    const def = captured.tools[0]
    const summary = await def.execute({})
    assert.equal(summary.ok, true)
    assert.ok(summary.totals.physical > 0)
    assert.equal(summary.largest, undefined)
    assert.ok(Array.isArray(summary.advice))

    const full = await def.execute({ detail: 'full' })
    assert.ok(Array.isArray(full.largest))
    assert.ok(full.largest.length > 0)
  })
})

test('路由：loopback 请求返回 200 与完整报告', async () => {
  await withRouteFixture(async ({ root, captured }) => {
    const res = makeRes()
    await captured.routes[0].handler(makeReq(), res)
    assert.equal(res.out.status, 200)
    assert.equal(res.out.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(res.out.headers['cache-control'], 'no-store')
    const body = JSON.parse(res.out.raw)
    assert.equal(body.ok, true)
    assert.equal(body.root, root)
    assert.ok(Array.isArray(body.modules))
    assert.ok(body.advice.some((a) => a.level === 'forbidden'))
  })
})

test('路由：只接受 GET/HEAD，其它方法返回 405', async () => {
  await withRouteFixture(async ({ captured }) => {
    const route = captured.routes[0]
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const req = makeReq()
      req.method = method
      const res = makeRes()
      await route.handler(req, res)
      assert.equal(res.out.status, 405, `${method} 应当被拒绝`)
      assert.equal(res.out.headers.allow, 'GET, HEAD')
    }
    const okReq = makeReq()
    okReq.method = 'GET'
    const okRes = makeRes()
    await route.handler(okReq, okRes)
    assert.equal(okRes.out.status, 200)
  })
})

test('工具：detail 传非法值时退回 summary 而不是报错', async () => {
  await withRouteFixture(async ({ captured }) => {
    const def = captured.tools[0]
    const result = await def.execute({ detail: 'weird' })
    assert.equal(result.ok, true)
    assert.equal(result.largest, undefined)
  })
})

test('路由：非本机来源一律 403', async () => {
  await withRouteFixture(async ({ captured }) => {
    const route = captured.routes[0]
    const cases = [
      ['局域网 socket', makeReq({ socket: { remoteAddress: '192.168.1.20' } })],
      ['公网 socket', makeReq({ socket: { remoteAddress: '203.0.113.9' } })],
      ['代理头 x-forwarded-for', makeReq({ headers: { 'x-forwarded-for': '1.2.3.4' } })],
      ['代理头 cf-connecting-ip', makeReq({ headers: { 'cf-connecting-ip': '1.2.3.4' } })],
      ['cross-site', makeReq({ headers: { 'sec-fetch-site': 'cross-site' } })],
      ['异源 Origin', makeReq({ headers: { origin: 'http://evil.example' } })],
      ['Host 非 loopback', makeReq({ headers: { host: 'dsh.example.com' } })],
    ]
    for (const [label, req] of cases) {
      const res = makeRes()
      await route.handler(req, res)
      assert.equal(res.out.status, 403, `${label} 应该被拒绝`)
      assert.equal(JSON.parse(res.out.raw).error, 'forbidden: loopback-only')
    }
  })
})

test('路由：同源 Origin 与 ::1 都放行', async () => {
  await withRouteFixture(async ({ captured }) => {
    const route = captured.routes[0]
    const sameOrigin = makeReq({ headers: { origin: 'http://127.0.0.1:57871' } })
    const resA = makeRes()
    await route.handler(sameOrigin, resA)
    assert.equal(resA.out.status, 200)

    const v6 = { socket: { remoteAddress: '::1' }, headers: { host: '[::1]:57871' } }
    const resB = makeRes()
    await route.handler(v6, resB)
    assert.equal(resB.out.status, 200)
  })
})

test('isLoopbackRequest：缺 Host 头直接拒绝', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), false)
  assert.equal(
    isLoopbackRequest({ socket: {}, headers: { host: '127.0.0.1:1' } }),
    false,
  )
})

test('resolveConfig：默认值、未知键、非法数字', () => {
  assert.deepEqual(resolveConfig(undefined), { cacheTtlMs: 300_000, timeoutMs: 10_000 })
  assert.deepEqual(resolveConfig({ cacheTtlMs: 0 }), { cacheTtlMs: 0, timeoutMs: 10_000 })
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key/)
  assert.throws(() => resolveConfig({ timeoutMs: 0 }), /greater than 0/)
  assert.throws(() => resolveConfig({ timeoutMs: -1 }), /non-negative/)
  assert.throws(() => resolveConfig({ timeoutMs: 'soon' }), /non-negative/)
})

test('路由：普通请求命中缓存，?force=1 绕过缓存', async () => {
  const root = await makeFixture()
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = root
  clearScanCache()
  try {
    const { ctx, captured } = makeContext()
    apply(ctx, { cacheTtlMs: 60_000 })
    const route = captured.routes[0]

    const call = async (url) => {
      const res = makeRes()
      await route.handler(makeReq({ url }), res)
      assert.equal(res.out.status, 200)
      return JSON.parse(res.out.raw)
    }

    const first = await call('/api/storage/report')
    assert.equal(first.cached, false)

    const second = await call('/api/storage/report')
    assert.equal(second.cached, true)

    const forced = await call('/api/storage/report?force=1')
    assert.equal(forced.cached, false, 'force=1 必须重新扫描')
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    clearScanCache()
    await rm(root, { recursive: true, force: true })
  }
})

test('卸载：路由 disposer 可回收，不残留注册', async () => {
  const root = await makeFixture()
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = root
  try {
    const { ctx, captured } = makeContext()
    const disposers = []
    ctx.effect = (fn) => {
      disposers.push(fn())
      return () => {}
    }
    apply(ctx, { cacheTtlMs: 0 })
    assert.equal(captured.routes.length, 1)
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    assert.equal(captured.routes.length, 0)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    clearScanCache()
    await rm(root, { recursive: true, force: true })
  }
})