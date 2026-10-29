/**
 * lib/scan.js —— 纯数据层（两个入口共用，唯一真源）
 *
 * 读取 $DSH_HOME（默认 ~/.dsh），回答三件事：谁占了空间、哪些值得关注、为什么。
 * 只读、不跟随符号链接、权限错误跳过；主数字采用 st_blocks × 512 的物理块口径，
 * 同时返回 st_size 逻辑大小，避免用户拿 Finder/du 对照时误以为算错。
 */
import { lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const BLOCK_SIZE = 512

export const DEFAULTS = {
  cacheTtlMs: 300_000,
  timeoutMs: 10_000,
  concurrency: 16,
  topFiles: 10,
}

const FORBIDDEN_MODULES = new Set(['dsh-runtimes'])
const CAUTION_MODULES = new Set([
  'sessions',
  'attachments',
  'storages',
  'backups',
  'integrations',
  'remote-web-ui-registry',
  'im',
])
const CACHE_DIR_NAMES = new Set(['cache', '.cache', '.vite', '.turbo', '.parcel-cache'])
const ZERO = { files: 0, dirs: 0, physical: 0, logical: 0 }

function addAgg(a, b) {
  return {
    files: a.files + b.files,
    dirs: a.dirs + b.dirs,
    physical: a.physical + b.physical,
    logical: a.logical + b.logical,
  }
}

export function physicalBytes(st) {
  const blocks = Number(st.blocks)
  if (Number.isFinite(blocks) && blocks > 0) return blocks * BLOCK_SIZE
  const size = Number(st.size)
  return Number.isFinite(size) && size > 0 ? size : 0
}

export function logicalBytes(st) {
  const size = Number(st.size)
  return Number.isFinite(size) && size > 0 ? size : 0
}

export function formatBytes(n) {
  const value = Number(n)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = value
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${units[i]}`
}

export function resolveRoot(options = {}) {
  if (typeof options.root === 'string' && options.root.trim() !== '') return options.root
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

function makeLimiter(concurrency) {
  const max = Math.max(1, Number(concurrency) || 1)
  let active = 0
  const waiters = []

  const release = () => {
    active -= 1
    const next = waiters.shift()
    if (next) {
      active += 1
      next()
    }
  }

  return (fn) =>
    new Promise((resolve, reject) => {
      const run = () => {
        let result
        try {
          result = fn()
        } catch (error) {
          release()
          reject(error)
          return
        }
        Promise.resolve(result).then(
          (value) => {
            release()
            resolve(value)
          },
          (error) => {
            release()
            reject(error)
          },
        )
      }
      if (active < max) {
        active += 1
        run()
      } else {
        waiters.push(run)
      }
    })
}

function addLargest(ctx, item) {
  if (item.physical <= 0) return
  const cap = ctx.topFiles
  if (ctx.largest.length < cap) {
    ctx.largest.push(item)
    return
  }
  let minIndex = 0
  for (let i = 1; i < ctx.largest.length; i += 1) {
    if (ctx.largest[i].physical < ctx.largest[minIndex].physical) minIndex = i
  }
  if (item.physical > ctx.largest[minIndex].physical) ctx.largest[minIndex] = item
}

async function scanFile(abs, relativePath, ctx) {
  let st
  try {
    st = await ctx.limit(() => lstat(abs))
  } catch {
    ctx.skipped += 1
    ctx.complete = false
    return ZERO
  }
  if (!st.isFile() && !st.isSymbolicLink()) return ZERO

  let physical = physicalBytes(st)
  let logical = logicalBytes(st)
  const nlink = Number(st.nlink) || 1
  if (nlink > 1 && st.dev !== undefined && st.ino !== undefined) {
    const key = `${st.dev}:${st.ino}`
    if (ctx.seenLinks.has(key)) {
      physical = 0
      logical = 0
    } else {
      ctx.seenLinks.add(key)
    }
  }

  ctx.files += 1
  addLargest(ctx, { path: relativePath.join('/'), physical, logical })
  return { files: 1, dirs: 0, physical, logical }
}

/**
 * 递归扫描一个目录。返回该目录（含自身）的聚合值。
 * `position.module` 始终是根目录的一级子项名；因此不会把所有模块误合成 null。
 */
async function walkDirectory(abs, position, ctx) {
  if (ctx.stopped) return ZERO
  if (Date.now() > ctx.deadline) {
    ctx.complete = false
    ctx.stopped = true
    return ZERO
  }

  let entries
  try {
    entries = await ctx.limit(() => readdir(abs, { withFileTypes: true }))
  } catch {
    ctx.skipped += 1
    ctx.complete = false
    return ZERO
  }

  const childResults = []
  const concurrency = ctx.concurrency
  const batchSize = Math.max(concurrency, concurrency * 4)
  for (let start = 0; start < entries.length; start += batchSize) {
    if (ctx.stopped || Date.now() > ctx.deadline) {
      ctx.complete = false
      ctx.stopped = true
      break
    }
    const batch = entries.slice(start, start + batchSize)
    const results = await Promise.all(
      batch.map(async (entry) => {
        if (ctx.stopped || Date.now() > ctx.deadline) {
          ctx.complete = false
          ctx.stopped = true
          return ZERO
        }

        const childAbs = join(abs, entry.name)
        const childPath = [...position.path, entry.name]

        if (entry.isDirectory()) {
          const sub = await walkDirectory(
            childAbs,
            {
              module: position.module,
              path: childPath,
              cacheAncestor: position.cacheAncestor || CACHE_DIR_NAMES.has(entry.name),
            },
            ctx,
          )
          if (!position.cacheAncestor && CACHE_DIR_NAMES.has(entry.name)) {
            ctx.cacheBytes += sub.physical
            ctx.cacheDirs.push(childPath.join('/'))
          }
          if (position.module === 'profiles' && childPath.length === 2) {
            ctx.profileBytes.set(entry.name, sub)
          }
          return addAgg({ ...ZERO, dirs: 1 }, sub)
        }

        return scanFile(childAbs, childPath, ctx)
      }),
    )
    childResults.push(...results)
  }

  const total = childResults.reduce(addAgg, { ...ZERO, dirs: 0 })
  return total
}

async function fingerprintRoot(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const parts = []
    for (const entry of entries) {
      try {
        const st = await lstat(join(root, entry.name))
        parts.push(`${entry.name}:${st.mtimeMs}:${st.size}:${st.mode}`)
      } catch {
        parts.push(`${entry.name}:unreadable`)
      }
    }
    return parts.sort().join('|')
  } catch {
    return null
  }
}

/**
 * 缓存指纹的已知边界（重要，别当它更聪明）：
 * 目录的 mtime 只在**直接子项**增删改名时变化，不随深层文件内容变化。
 * 因此「profiles/desktop/node_modules/x/.../big.bin 变大」这类深层改动，
 * 指纹不会变化，只能靠 TTL（默认 5 分钟）兜底。
 * 这是有意的取舍：全量指纹要再扫一遍，成本等于扫描本身。
 */

async function scanRaw(options) {
  const root = resolveRoot(options)
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULTS.timeoutMs
  const topFiles = Number(options.topFiles) > 0 ? Math.floor(Number(options.topFiles)) : DEFAULTS.topFiles
  const startedAt = Date.now()
  const concurrency = Number(options.concurrency) > 0 ? Math.floor(Number(options.concurrency)) : DEFAULTS.concurrency
  const ctx = {
    deadline: startedAt + timeoutMs,
    limit: makeLimiter(concurrency),
    concurrency,
    topFiles,
    complete: true,
    stopped: false,
    files: 0,
    skipped: 0,
    cacheBytes: 0,
    cacheDirs: [],
    seenLinks: new Set(),
    largest: [],
    profileBytes: new Map(),
  }

  let entries
  try {
    entries = await ctx.limit(() => readdir(root, { withFileTypes: true }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取 DSH 根目录 ${root}: ${message}`)
  }

  // 模块列表只展示非隐藏条目；隐藏条目（.credentials.yaml 等）仍计入总量，
  // 但不作为「模块」呈现——它们既不该出现在存储地图里，也不该被建议删除。
  const modules = new Map()
  let totals = { ...ZERO, dirs: 0 }

  for (const entry of entries) {
    if (Date.now() > ctx.deadline) {
      ctx.complete = false
      break
    }
    const childAbs = join(root, entry.name)
    const childPath = [entry.name]
    let result
    if (entry.isDirectory()) {
      result = await walkDirectory(
        childAbs,
        {
          module: entry.name,
          path: childPath,
          cacheAncestor: CACHE_DIR_NAMES.has(entry.name),
        },
        ctx,
      )
      result = addAgg({ ...ZERO, dirs: 1 }, result)
      if (CACHE_DIR_NAMES.has(entry.name)) {
        ctx.cacheBytes += result.physical
        ctx.cacheDirs.push(entry.name)
      }
    } else {
      result = await scanFile(childAbs, childPath, ctx)
    }
    totals = addAgg(totals, result)
    if (!entry.name.startsWith('.')) modules.set(entry.name, result)
  }

  ctx.largest.sort((a, b) => b.physical - a.physical)

  return {
    root,
    scannedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    complete: ctx.complete,
    totals: { ...totals, skipped: ctx.skipped },
    modules: [...modules.entries()].map(([name, value]) => ({
      name,
      kind: value.dirs > 0 ? 'dir' : 'file',
      physical: value.physical,
      logical: value.logical,
      files: value.files,
      dirs: value.dirs,
    })),
    profiles: [...ctx.profileBytes.entries()].map(([name, value]) => ({
      name,
      physical: value.physical,
      logical: value.logical,
      files: value.files,
      dirs: value.dirs,
    })),
    largest: ctx.largest,
    cacheBytes: ctx.cacheBytes,
    cacheDirs: [...new Set(ctx.cacheDirs)],
    fingerprint: await fingerprintRoot(root),
  }
}

export function buildAdvice(raw, activeProfile) {
  const advice = []
  const byName = new Map(raw.modules.map((m) => [m.name, m]))

  const runtime = byName.get('dsh-runtimes')
  if (runtime) {
    advice.push({
      level: 'forbidden',
      module: 'dsh-runtimes',
      bytes: runtime.physical,
      title: '不要动：DSH 自带运行时',
      detail: 'node / python / pnpm 运行时，DSH 启动依赖它。删掉不会自动重装，DSH 会直接起不来。',
    })
  }

  if (raw.cacheBytes > 0) {
    const dirs = raw.cacheDirs
    advice.push({
      level: 'safe',
      module: dirs.length === 1 ? dirs[0] : `${dirs[0]} 等 ${dirs.length} 处`,
      bytes: raw.cacheBytes,
      title: '可删：缓存目录',
      detail: `缓存（${dirs.slice(0, 3).join('、')}${dirs.length > 3 ? ' 等' : ''}）删掉只会让下次使用重建，不丢数据。`,
    })
  }

  const cautionCopy = {
    sessions: ['谨慎：会话历史', '删了对应会话就找不回来了。要清请用会话归档插件，本插件只显示体积，不做第二套删除。'],
    attachments: ['谨慎：会话附件', '历史消息里的图片和文件本体在这里，删了消息还在但附件打不开。'],
    storages: ['谨慎：插件数据', '插件的持久化数据（设置、索引、看板）。删了对应插件会回到初始状态。'],
    backups: ['谨慎：DSH 备份', '一般只留最近几份，旧的可以删；但删之前确认最近一次备份是可用的。'],
    integrations: ['谨慎：外部集成', '保存第三方集成与授权相关数据，删除前确认不再使用。'],
    'remote-web-ui-registry': ['谨慎：远程配对登记', '保存远程 Web UI 的配对登记，删除后远程设备需要重新配对。'],
    im: ['谨慎：消息集成', '保存 IM 通道相关数据，删除前确认不再使用。'],
  }
  for (const mod of raw.modules) {
    if (!CAUTION_MODULES.has(mod.name)) continue
    if (mod.physical <= 0) continue
    const [title, detail] = cautionCopy[mod.name] ?? ['谨慎：DSH 数据', '删除前确认你不再需要这里的数据。']
    advice.push({ level: 'caution', module: mod.name, bytes: mod.physical, title, detail })
  }

  for (const profile of raw.profiles) {
    if (profile.name === activeProfile) continue
    if (profile.physical <= 0) continue
    advice.push({
      level: 'caution',
      module: `profiles/${profile.name}`,
      bytes: profile.physical,
      title: `谨慎：未在用的 profile「${profile.name}」`,
      detail: '确认没有定时任务或其它入口在用它后，整个目录可以删；其中的插件会一起消失。',
    })
  }

  const forbiddenBytes = advice
    .filter((item) => item.level === 'forbidden')
    .reduce((sum, item) => sum + item.bytes, 0)
  const reclaimableBytes = Math.min(
    raw.totals.physical,
    advice.filter((item) => item.level !== 'forbidden').reduce((sum, item) => sum + item.bytes, 0),
  )

  return { advice, reclaimableBytes, forbiddenBytes }
}

const cacheStore = new Map()

export async function scan(options = {}) {
  const root = resolveRoot(options)
  const ttl = options.cacheTtlMs === undefined ? DEFAULTS.cacheTtlMs : Number(options.cacheTtlMs)
  const activeProfile = options.activeProfile ?? process.env.DSH_PROFILE ?? null
  const cacheKey = `${root}::${activeProfile ?? ''}`

  if (!options.force && ttl > 0) {
    const hit = cacheStore.get(cacheKey)
    if (hit && Date.now() - hit.at < ttl) {
      const fingerprint = await fingerprintRoot(root)
      if (fingerprint !== null && fingerprint === hit.fingerprint) {
        return { ...hit.value, cached: true, cacheAgeMs: Date.now() - hit.at }
      }
    }
  }

  const raw = await scanRaw(options)
  const advice = buildAdvice(raw, activeProfile)
  const report = {
    ok: true,
    root: raw.root,
    scannedAt: raw.scannedAt,
    durationMs: raw.durationMs,
    complete: raw.complete,
    cached: false,
    cacheAgeMs: 0,
    activeProfile,
    totals: raw.totals,
    modules: raw.modules
      .slice()
      .sort((a, b) => b.physical - a.physical)
      .map((module) => ({
        ...module,
        percent: raw.totals.physical > 0 ? Number(((module.physical / raw.totals.physical) * 100).toFixed(1)) : 0,
        level: FORBIDDEN_MODULES.has(module.name)
          ? 'forbidden'
          : CACHE_DIR_NAMES.has(module.name)
            ? 'safe'
            : CAUTION_MODULES.has(module.name)
              ? 'caution'
              : 'neutral',
      })),
    profiles: raw.profiles.slice().sort((a, b) => b.physical - a.physical),
    largest: raw.largest,
    cacheBytes: raw.cacheBytes,
    cacheDirs: raw.cacheDirs,
    ...advice,
  }

  if (ttl > 0) cacheStore.set(cacheKey, { at: Date.now(), fingerprint: raw.fingerprint, value: report })
  return report
}

export function clearScanCache() {
  cacheStore.clear()
}

export function toSummary(report) {
  return {
    ok: report.ok,
    root: report.root,
    totals: report.totals,
    reclaimableBytes: report.reclaimableBytes,
    modules: report.modules.map((module) => ({
      name: module.name,
      bytes: module.physical,
      percent: module.percent,
      level: module.level,
    })),
    advice: report.advice.map((item) => ({
      level: item.level,
      module: item.module,
      title: item.title,
      bytes: item.bytes,
    })),
    complete: report.complete,
    durationMs: report.durationMs,
    cached: report.cached,
  }
}
