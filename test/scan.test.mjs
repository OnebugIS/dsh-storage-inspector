import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULTS,
  buildAdvice,
  clearScanCache,
  formatBytes,
  logicalBytes,
  physicalBytes,
  resolveRoot,
  scan,
  toSummary,
} from '../lib/scan.js'

/** 造一棵固定大小的假 DSH 目录树，返回根路径与预期逻辑字节。 */
async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-storage-fixture-'))
  const mk = async (rel, bytes) => {
    const abs = join(root, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, 'x'.repeat(bytes))
  }

  await mk('a.bin', 4096)
  await mk('dir/b.bin', 8192)
  await mk('dir/c.bin', 1024)
  await mk('cache/x.bin', 2048)
  await mk('dsh-runtimes/node/bin', 512)
  await mk('sessions/s1.json', 256)
  await mk('profiles/desktop/node_modules/pkg/p.js', 128)
  await mk('profiles/headless/node_modules/pkg/p.js', 64)

  // 硬链接：同一 inode 只应计一次
  await mkdir(join(root, 'hard'), { recursive: true })
  await link(join(root, 'a.bin'), join(root, 'hard/a-link.bin'))

  // 符号链接：绝不跟随，否则 dir/ 会被算两遍
  await symlink('dir', join(root, 'link-to-dir'))

  const expectedRegular = 4096 + 8192 + 1024 + 2048 + 512 + 256 + 128 + 64
  const expectedSymlink = Buffer.byteLength('dir')
  return { root, expectedLogical: expectedRegular + expectedSymlink }
}

async function withFixture(fn) {
  const fixture = await makeFixture()
  try {
    return await fn(fixture)
  } finally {
    clearScanCache()
    await rm(fixture.root, { recursive: true, force: true })
  }
}

test('formatBytes：边界与单位', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(-1), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1024 * 1024), '1.0 MB')
  assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB')
  assert.equal(formatBytes(1024 ** 3), '1.0 GB')
})

test('physicalBytes：优先物理块，缺字段时退回逻辑大小', () => {
  assert.equal(physicalBytes({ blocks: 8, size: 100 }), 4096)
  assert.equal(physicalBytes({ blocks: 0, size: 100 }), 100)
  assert.equal(physicalBytes({ size: 100 }), 100)
  assert.equal(physicalBytes({ blocks: 0, size: 0 }), 0)
  assert.equal(physicalBytes({}), 0)
  assert.equal(logicalBytes({ size: 123 }), 123)
  assert.equal(logicalBytes({}), 0)
})

test('resolveRoot：显式参数 > 环境变量 > ~/.dsh', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/from-env'
    assert.equal(resolveRoot({ root: '/tmp/explicit' }), '/tmp/explicit')
    assert.equal(resolveRoot({}), '/tmp/from-env')
    delete process.env.DSH_HOME
    assert.ok(resolveRoot({}).endsWith('/.dsh'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('scan：隐藏根条目计入总量但不伪装成可见模块', async () => {
  await withFixture(async ({ root }) => {
    const hidden = join(root, '.private')
    await writeFile(hidden, 'secret-config')
    const report = await scan({ root, cacheTtlMs: 0, activeProfile: 'desktop' })
    assert.ok(report.totals.logical >= Buffer.byteLength('secret-config'))
    assert.ok(!report.modules.some((module) => module.name === '.private'))
    assert.ok(report.complete)
  })
})

test('scan：隐藏的缓存目录计入可回收缓存，但不列为可见模块', async () => {
  await withFixture(async ({ root }) => {
    await mkdir(join(root, '.vite'), { recursive: true })
    await writeFile(join(root, '.vite', 'bundle'), 'built-cache')
    const report = await scan({ root, cacheTtlMs: 0 })

    // 隐藏条目一律不作为模块展示（避免把 .credentials.yaml 之类摆上台面）
    assert.equal(report.modules.find((module) => module.name === '.vite'), undefined)
    // 但它仍然是缓存，计入可回收口径
    assert.ok(report.cacheDirs.includes('.vite'))
    assert.ok(report.cacheBytes > 0)
    assert.ok(report.advice.some((item) => item.level === 'safe' && item.bytes > 0))
  })
})

test('scan：嵌套缓存只记最外层一次，不重复计', async () => {
  await withFixture(async ({ root }) => {
    await mkdir(join(root, 'cache', '.cache'), { recursive: true })
    await writeFile(join(root, 'cache', '.cache', 'inner'), 'nested')
    const report = await scan({ root, cacheTtlMs: 0 })
    assert.ok(report.cacheDirs.includes('cache'))
    assert.ok(
      !report.cacheDirs.includes('cache/.cache'),
      '嵌套缓存不应被重复登记，否则可回收会被重复计算',
    )
  })
})

test('scan：topFiles 参数控制最大文件榜长度', async () => {
  await withFixture(async ({ root }) => {
    const report = await scan({ root, cacheTtlMs: 0, topFiles: 3 })
    assert.equal(report.largest.length, 3)
  })
})

test('scan：缓存指纹已知边界——深层文件改动由 TTL 兜底', async () => {
  await withFixture(async ({ root }) => {
    const first = await scan({ root, cacheTtlMs: 60_000 })
    await writeFile(join(root, 'profiles', 'desktop', 'node_modules', 'pkg', 'p.js'), 'changed-deep-content')
    const second = await scan({ root, cacheTtlMs: 60_000 })
    // 根级 mtime 指纹不递归；这是性能取舍，最多持续到 TTL 到期。
    assert.equal(second.cached, true)
    assert.equal(second.scannedAt, first.scannedAt)
  })
})

test('scan：逻辑口径精确、符号链接不跟随、硬链接只计一次', async () => {
  await withFixture(async ({ root, expectedLogical }) => {
    const report = await scan({ root, cacheTtlMs: 0, activeProfile: 'desktop' })

    assert.equal(report.ok, true)
    assert.equal(report.root, root)
    // 精确的 st_size 合计：dir/ 的内容只算一遍（符号链接没被跟随），硬链接只算一遍
    assert.equal(report.totals.logical, expectedLogical)
    // 物理块口径一定 ≥ 逻辑口径（小块文件会被块大小放大）
    assert.ok(report.totals.physical >= report.totals.logical)
    assert.ok(report.totals.files >= 9)
    assert.equal(report.totals.skipped, 0)
    assert.equal(report.complete, true)
  })
})

test('scan：模块分级与可回收口径', async () => {
  await withFixture(async ({ root }) => {
    const report = await scan({ root, cacheTtlMs: 0, activeProfile: 'desktop' })
    const byName = new Map(report.modules.map((m) => [m.name, m]))

    assert.equal(byName.get('dsh-runtimes').level, 'forbidden')
    assert.equal(byName.get('cache').level, 'safe')
    assert.equal(byName.get('sessions').level, 'caution')
    assert.equal(byName.get('profiles').level, 'neutral')

    // 建议区：禁止项一定在，且明确点名
    const forbidden = report.advice.filter((a) => a.level === 'forbidden')
    assert.equal(forbidden.length, 1)
    assert.equal(forbidden[0].module, 'dsh-runtimes')
    assert.ok(forbidden[0].detail.includes('起不来'))

    // 缓存进「可删」
    assert.ok(report.advice.some((a) => a.level === 'safe' && a.bytes > 0))
    // 会话历史进「谨慎」
    assert.ok(report.advice.some((a) => a.level === 'caution' && a.module === 'sessions'))

    // 未在用的 profile 被点名，正在用的不被点名
    const profileAdvice = report.advice.filter((a) => a.module && a.module.startsWith('profiles/'))
    assert.deepEqual(profileAdvice.map((a) => a.module), ['profiles/headless'])

    // 可回收 = 非禁止项之和，且不超过总量
    assert.ok(report.reclaimableBytes > 0)
    assert.ok(report.reclaimableBytes <= report.totals.physical)
    assert.ok(report.forbiddenBytes >= byName.get('dsh-runtimes').physical)
    // 禁止项不得混进可回收
    assert.ok(report.reclaimableBytes + report.forbiddenBytes <= report.totals.physical + 1)
  })
})

test('scan：缓存命中与强制刷新', async () => {
  await withFixture(async ({ root }) => {
    const first = await scan({ root, cacheTtlMs: 60_000 })
    assert.equal(first.cached, false)

    const second = await scan({ root, cacheTtlMs: 60_000 })
    assert.equal(second.cached, true)

    const forced = await scan({ root, cacheTtlMs: 60_000, force: true })
    assert.equal(forced.cached, false)
  })
})

test('buildAdvice：零字节模块不出建议，active profile 不被点名', () => {
  const raw = {
    modules: [
      { name: 'sessions', physical: 100, logical: 100 },
      { name: 'storages', physical: 0, logical: 0 },
      { name: 'dsh-runtimes', physical: 900, logical: 900 },
    ],
    profiles: [{ name: 'desktop', physical: 500 }],
    cacheBytes: 0,
    cacheDirs: [],
    totals: { physical: 1000, logical: 1000 },
  }
  const result = buildAdvice(raw, 'desktop')
  assert.equal(result.advice.length, 2)
  assert.ok(result.advice.every((a) => a.module !== 'storages'))
  assert.equal(result.forbiddenBytes, 900)
  assert.equal(result.reclaimableBytes, 100)
})

test('toSummary：保留总量与建议，不带最大文件', async () => {
  await withFixture(async ({ root }) => {
    const report = await scan({ root, cacheTtlMs: 0 })
    const summary = toSummary(report)
    assert.equal(summary.ok, true)
    assert.ok(summary.totals.physical > 0)
    assert.ok(Array.isArray(summary.modules))
    assert.ok(Array.isArray(summary.advice))
    assert.equal(summary.largest, undefined)
    assert.equal(typeof summary.reclaimableBytes, 'number')
  })
})

test('DEFAULTS：缓存 TTL 与超时是正数', () => {
  assert.ok(DEFAULTS.cacheTtlMs > 0)
  assert.ok(DEFAULTS.timeoutMs > 0)
  assert.ok(DEFAULTS.concurrency > 0)
})

test('真机集成：扫描真实 DSH 目录（存在时）', async (t) => {
  const realRoot = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  if (!existsSync(realRoot)) {
    t.skip(`没有 ${realRoot}`)
    return
  }
  const report = await scan({ root: realRoot, cacheTtlMs: 0, timeoutMs: 20_000 })
  assert.equal(report.ok, true)
  assert.ok(report.totals.files > 100)
  assert.ok(report.totals.physical > 0)
  assert.ok(report.durationMs < 20_000)
  // 真实目录里必有运行时，且一定被标成禁止
  assert.ok(report.modules.some((m) => m.name === 'dsh-runtimes' && m.level === 'forbidden'))
})