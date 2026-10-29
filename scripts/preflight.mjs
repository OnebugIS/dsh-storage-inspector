#!/usr/bin/env node
/**
 * 发布前预检：在 npm publish 之前把"能自动查的都查掉"。
 * 只读，不改任何文件；任何一项不通过都以非零退出码结束。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
const errors = []

const fail = (message) => errors.push(message)

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(abs)))
    else files.push(abs)
  }
  return files
}

// 1. 清单身份与 DSH 声明
if (pkg.name !== 'dsh-storage-inspector') fail('包名不符：应为 dsh-storage-inspector')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('缺少 dsh.bundle.patch')
if (pkg.dsh?.client?.platform !== 'web') fail('dsh.client.platform 必须是 web')

// 2. 绝不允许核心包依赖（2026-10-27 事故根因）
const deps = { ...(pkg.dependencies || {}), ...(pkg.peerDependencies || {}) }
const coreDeps = Object.keys(deps).filter((name) => name.startsWith('@deepseek-ai/'))
if (coreDeps.length) fail(`禁止依赖宿主核心包：${coreDeps.join(', ')}`)

// 3. 运行时文件齐全，且都在 files 白名单内
const required = [
  'lib/scan.js',
  'lib/index.js',
  'lib/client.js',
  'cordis.patch.yml',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
  'README.md',
  'README.en.md',
  'LICENSE',
]
const files = pkg.files || []
for (const rel of required) {
  if (!(await exists(join(packageDir, rel)))) fail(`缺少发布文件：${rel}`)
  const covered = files.some((entry) => rel === entry || rel.startsWith(`${entry}/`) || entry === rel.split('/')[0])
  if (!covered) fail(`package.json files 未包含 ${rel}`)
}

// 4. 双语元数据与界面标题一致
const zh = JSON.parse(await readFile(join(packageDir, 'locale/zh.json'), 'utf8'))
const en = JSON.parse(await readFile(join(packageDir, 'locale/en.json'), 'utf8'))
if (!zh.meta?.title || !zh.meta?.description) fail('locale/zh.json 缺 meta.title 或 meta.description')
if (!en.meta?.title || !en.meta?.description) fail('locale/en.json 缺 meta.title 或 meta.description')
if (JSON.stringify(Object.keys(zh).sort()) !== JSON.stringify(Object.keys(en).sort())) {
  fail('中英 locale 顶层键不一致')
}
if (zh.meta?.title !== zh.storage?.title) fail('meta.title 应与 storage.title 同名，避免导航与标题不一致')

const client = await readFile(join(packageDir, 'lib/client.js'), 'utf8')
if (zh.storage?.title && !client.includes(`'storage.title': '${zh.storage.title}'`)) {
  fail('client.js 内联标题与 locale 不一致')
}

// 5. patch 必须是 insert，不能裸写顶层 id
const patch = await readFile(join(packageDir, 'cordis.patch.yml'), 'utf8')
if (!/^- insert:/m.test(patch)) fail('cordis.patch.yml 必须使用 - insert:')
if (/^- id:/m.test(patch)) fail('cordis.patch.yml 出现顶层 - id:，会静默覆盖而非新增')

// 6. 图标可用
const icon = await readFile(join(packageDir, 'icon.svg'), 'utf8')
const iconSize = (await stat(join(packageDir, 'icon.svg'))).size
if (!/<svg[\s>]/.test(icon) || !/viewBox=/.test(icon)) fail('icon.svg 必须是带 viewBox 的有效 SVG')
if (iconSize > 256 * 1024) fail('icon.svg 超过 256 KiB')

// 7. README 必须写安装与只读
const readme = await readFile(join(packageDir, 'README.md'), 'utf8')
const readmeEn = await readFile(join(packageDir, 'README.en.md'), 'utf8')
for (const [name, text] of [
  ['README.md', readme],
  ['README.en.md', readmeEn],
]) {
  if (!/dsh plugin --profile/.test(text)) fail(`${name} 缺安装命令`)
}
if (!/只读/.test(readme)) fail('README.md 必须写明只读')
if (!/Read-only/i.test(readmeEn)) fail('README.en.md 必须写明 read-only')

// 8. 包内不得夹带本机路径、临时缓存或 tarball
for (const abs of await walk(packageDir)) {
  const rel = relative(packageDir, abs).split(sep).join('/')
  if (rel.startsWith('test/') || rel.startsWith('scripts/')) continue
  if (rel.endsWith('.tgz')) fail(`包内不应存在 tarball：${rel}`)
  if (rel.startsWith('.npm-cache-tmp')) fail(`包内不应存在临时缓存：${rel}`)
  if (rel.endsWith('.log')) fail(`包内不应存在日志：${rel}`)
  const buffer = await readFile(abs).catch(() => Buffer.alloc(0))
  if (!buffer.length) continue
  const text = buffer.toString('utf8')
  if (text.includes('/Users/maojinfang')) fail(`${rel} 含本机绝对路径`)
}

if (errors.length) {
  console.error('发布预检未通过：')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`发布预检通过：${pkg.name}@${pkg.version}`)
