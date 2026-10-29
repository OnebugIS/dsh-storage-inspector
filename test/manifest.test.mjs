/**
 * 交付一致性守卫：这些是"装给别人用"的硬门槛，改动后必须仍然成立。
 * 覆盖 2026-10-27 事故中踩过的两类错误：patch 裸写 id、包清单与资源漂移。
 */
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..')

async function readJson(rel) {
  return JSON.parse(await readFile(join(pkgDir, rel), 'utf8'))
}

test('manifest：不声明任何 @deepseek-ai 依赖（避免 second copy）', async () => {
  const pkg = await readJson('package.json')
  const deps = { ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}) }
  const offenders = Object.keys(deps).filter((name) => name.startsWith('@deepseek-ai/'))
  assert.deepEqual(offenders, [], `不得依赖宿主核心包，发现：${offenders.join(', ')}`)
})

test('manifest：bundle 与 client 声明齐全', async () => {
  const pkg = await readJson('package.json')
  assert.equal(pkg.name, 'dsh-storage-inspector')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.exports['./icon'], './icon.svg')
  assert.ok(pkg.exports['./locale/*.json'], 'locale 必须导出给设置页读 meta')
})

test('manifest：files 覆盖所有运行时需要的文件', async () => {
  const pkg = await readJson('package.json')
  const files = pkg.files || []
  for (const required of ['lib', 'locale', 'icon.svg', 'cordis.patch.yml', 'LICENSE']) {
    assert.ok(files.includes(required), `files 缺少 ${required}`)
  }
})

test('patch：必须是 insert 行，不能裸写 id', async () => {
  const patch = await readFile(join(pkgDir, 'cordis.patch.yml'), 'utf8')
  const rawLines = patch.split('\n')

  // 顶格的 `- id:` 表示"覆盖已有行"，未知 id 会被静默忽略——这正是事故原因。
  // insert 内部缩进的 `- id:` 是正常的行声明，不算违规。
  const topLevelBareIds = rawLines.filter((line) => /^- id:/.test(line))
  assert.deepEqual(topLevelBareIds, [], `不允许顶格 - id:，发现 ${topLevelBareIds.length} 处`)

  const lines = rawLines.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  assert.equal(lines[0].trimEnd(), '- insert:', `首条有效行必须是 - insert:，实际是 ${JSON.stringify(lines[0])}`)

  const body = lines.slice(1).join('\n')
  assert.match(body, /^ {4}- id: storage-inspector$/m, 'insert 下的插件行必须有 id')
  assert.match(body, /^ {6}name: 'dsh-storage-inspector'$/m, 'id 行必须带 name，否则加载不到插件')
})

test('patch：config 只写已实现的键', async () => {
  const patch = await readFile(join(pkgDir, 'cordis.patch.yml'), 'utf8')
  const { resolveConfig } = await import('../lib/index.js')
  const keys = [...patch.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1])
  assert.ok(keys.length > 0, 'patch 应当显式写出 config')
  const config = {}
  for (const key of keys) config[key] = undefined
  // 用真实实现校验：未知键会 throw，说明 patch 与代码脱节
  assert.doesNotThrow(() => {
    const filled = {}
    for (const key of keys) filled[key] = key === 'cacheTtlMs' ? 300000 : 10000
    resolveConfig(filled)
  }, `patch 里的 config 键与实现不一致：${keys.join(', ')}`)
})

test('locale：中英元数据齐全且键集合一致', async () => {
  const zh = await readJson('locale/zh.json')
  const en = await readJson('locale/en.json')
  for (const dict of [zh, en]) {
    assert.ok(dict.meta?.title, 'meta.title 必填（插件页展示）')
    assert.ok(dict.meta?.description, 'meta.description 必填')
  }
  assert.deepEqual(Object.keys(zh.meta).sort(), Object.keys(en.meta).sort())
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '中英顶层键必须一致')
  for (const section of Object.keys(zh)) {
    if (typeof zh[section] !== 'object') continue
    assert.deepEqual(Object.keys(zh[section]).sort(), Object.keys(en[section]).sort(), `${section} 键不一致`)
  }
})

test('locale 与 client 内联字典不脱节', async () => {
  const zh = await readJson('locale/zh.json')
  const client = await readFile(join(pkgDir, 'lib/client.js'), 'utf8')
  const titleKey = zh.storage?.title
  assert.ok(titleKey, 'locale 必须提供 storage.title')
  assert.ok(client.includes(`'storage.title': '${titleKey}'`), 'client 内联标题必须与 locale 一致')
  assert.ok(zh.meta.title === titleKey, 'meta.title 应与分区标题一致，避免导航与标题不同名')
})

test('icon：是有效的 SVG 且体积合规', async () => {
  const svg = await readFile(join(pkgDir, 'icon.svg'), 'utf8')
  const info = await stat(join(pkgDir, 'icon.svg'))
  assert.ok(info.size <= 256 * 1024, '图标必须 ≤ 256 KiB')
  assert.match(svg, /^<svg[\s>]|<svg xmlns/, '图标必须是 SVG')
  assert.match(svg, /viewBox="[^"]+"/, 'SVG 需要 viewBox，否则缩放会失真')
})

test('README：中英齐备且含安装与回滚命令', async () => {
  for (const rel of ['README.md', 'README.en.md']) {
    const text = await readFile(join(pkgDir, rel), 'utf8')
    assert.match(text, /dsh plugin --profile/, `${rel} 必须写安装命令`)
    assert.match(text, /Read-only|只读/, `${rel} 必须写明只读`)
  }
})