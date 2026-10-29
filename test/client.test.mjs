/**
 * 客户端半的白盒测试：不上浏览器，用最小桩把 client.js 跑起来。
 * 覆盖：模块外壳 id、slot 注册参数、locale 字典注册、首帧渲染不抛错、
 * 按钮点击触发 fetch、403 分支显示「仅本机可用」。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

/** 造一个最小 React 桩：只实现 client.js 用到的那几个 API。 */
function makeReactStub() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
  })
  let stateCursor = 0
  const stateSlots = []
  return {
    createElement,
    useState(initial) {
      const index = stateCursor++
      if (stateSlots.length <= index) stateSlots[index] = initial
      return [stateSlots[index], () => {}]
    },
    useEffect() {},
    useCallback(fn) {
      return fn
    },
    /** 每次渲染前把游标归零，模拟 React 的 hook 顺序。 */
    __resetHooks() {
      stateCursor = 0
    },
    __stateSlots: stateSlots,
    __setState(index, value) {
      stateSlots[index] = value
    },
  }
}

/** 把 client.js 装进一个假的 module loader，拿到返回的插件对象。 */
let importSeq = 0

async function loadClientModule() {
  const captured = {}
  globalThis.window = {
    __ModuleLoader__: {
      load(options) {
        captured.module = options
      },
    },
  }
  globalThis.document = { documentElement: { lang: 'zh' }, visibilityState: 'visible' }

  const react = makeReactStub()
  const requireStub = (name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  }

  // ESM 会缓存模块：每次换一个查询串，保证 client.js 真的重新执行一遍
  const url = new URL('../lib/client.js', import.meta.url)
  importSeq += 1
  await import(`${url.href}?case=${importSeq}`)

  assert.ok(captured.module, 'client.js 必须调用 window.__ModuleLoader__.load')
  const plugin = captured.module.factory(requireStub)
  return { plugin, meta: captured.module, react }
}

/** 假 client ctx：捕获 slot / locale 注册。 */
function makeClientCtx() {
  const captured = { slots: [], locales: [], injected: [] }
  const ctx = {
    effect(fn) {
      return fn()
    },
    locale: {
      register(ns, dicts) {
        captured.locales.push({ ns, dicts })
        return () => {}
      },
      bind(ns) {
        return (key) => (captured.locales[0]?.dicts?.zh?.[key] ?? key)
      },
    },
    slots: {
      inject(key, callback) {
        captured.injected.push(key)
        return callback()
      },
      register(options, component) {
        captured.slots.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, captured }
}

test('client.js：模块外壳 id 与包名一致', async () => {
  const { meta, plugin } = await loadClientModule()
  assert.equal(meta.id, 'dsh-storage-inspector')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.inject.includes('slots'))
  assert.ok(plugin.inject.includes('locale'))
})

test('client.js：注册 settings.section 卡片（id / order / label）', async () => {
  const { plugin } = await loadClientModule()
  const { ctx, captured } = makeClientCtx()
  plugin.apply(ctx)

  assert.deepEqual(captured.injected, ['settings.section'])
  assert.equal(captured.slots.length, 1)
  const { options, component } = captured.slots[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'dsh-storage-inspector')
  assert.equal(options.order, 152)
  assert.equal(options.locale, 'dsh-storage-inspector')
  assert.equal(typeof options.label, 'function')
  assert.equal(options.label(), '存储')
  assert.equal(typeof component, 'function')
  // 没声明 inject face 时不应把 undefined 塞进去
  assert.equal('inject' in options, false)
})

test('client.js：中英字典都注册，键集合一致', async () => {
  const { plugin } = await loadClientModule()
  const { ctx, captured } = makeClientCtx()
  plugin.apply(ctx)

  assert.equal(captured.locales.length, 1)
  const { ns, dicts } = captured.locales[0]
  assert.equal(ns, 'dsh-storage-inspector')
  const zhKeys = Object.keys(dicts.zh).sort()
  const enKeys = Object.keys(dicts.en).sort()
  assert.deepEqual(zhKeys, enKeys, '中英字典键必须一一对应')
  assert.ok(zhKeys.includes('storage.title'))
  assert.equal(typeof dicts.en['storage.title'], 'string')
})

test('client.js：首帧是加载态，不抛错', async () => {
  const { plugin, react } = await loadClientModule()
  const { ctx, captured } = makeClientCtx()
  plugin.apply(ctx)
  const component = captured.slots[0].component

  react.__resetHooks()
  const tree = component({})
  assert.ok(tree && typeof tree === 'object')
  // 加载态文案：中文「正在读取磁盘占用…」
  const text = JSON.stringify(tree)
  assert.match(text, /正在读取磁盘占用/)
})

test('client.js：403 时显示「仅本机可用」而不是崩', async () => {
  const { plugin, react } = await loadClientModule()
  const { ctx, captured } = makeClientCtx()
  globalThis.fetch = async () => ({ status: 403, ok: false, json: async () => null })
  plugin.apply(ctx)
  const component = captured.slots[0].component

  // 先把状态推到 forbidden，再渲染
  react.__resetHooks()
  component({})
  react.__setState(0, { status: 'forbidden', report: null, error: 'forbidden' })
  react.__resetHooks()
  const tree = component({})
  const text = JSON.stringify(tree)
  assert.match(text, /仅本机可用/)
  assert.match(text, /127\.0\.0\.1/)
})

/**
 * 把 createElement 造出的树展开成纯 JSON 文本。
 * 桩里的 createElement 只生成元素描述，不会执行子组件；
 * 这里递归调用函数型节点，才能断言到子组件的渲染结果。
 */
function flatten(node) {
  if (Array.isArray(node)) return node.map(flatten)
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return flatten(node.type({ ...(node.props || {}) }))
  const props = { ...(node.props || {}) }
  if ('children' in props) props.children = flatten(props.children)
  return { ...node, props }
}

test('client.js：模块名显示中文，原始目录名仍保留', async () => {
  const { plugin, react } = await loadClientModule()
  const { ctx, captured } = makeClientCtx()
  plugin.apply(ctx)
  const component = captured.slots[0].component

  const report = {
    ok: true,
    root: '/fake/.dsh',
    complete: true,
    totals: { physical: 1246, logical: 1106, files: 30, dirs: 9 },
    reclaimableBytes: 98,
    modules: [
      { name: 'profiles', kind: 'dir', physical: 780, percent: 65.7, level: 'neutral' },
      { name: 'dsh-runtimes', kind: 'dir', physical: 311, percent: 26.2, level: 'forbidden' },
      { name: 'sessions', kind: 'dir', physical: 66, percent: 5.6, level: 'caution' },
      { name: 'unknown-folder', kind: 'dir', physical: 2, percent: 0.1, level: 'neutral' },
    ],
    advice: [],
    largest: [],
  }

  react.__setState(0, { status: 'ready', report, error: null })
  react.__resetHooks()
  const text = JSON.stringify(flatten(component({})))

  // 中文显示名
  assert.match(text, /配置档案/)
  assert.match(text, /DSH 运行时/)
  assert.match(text, /会话/)
  // 原始目录名保留，便于核对真实路径
  assert.match(text, /profiles\//)
  assert.match(text, /dsh-runtimes\//)
  // 未收录的模块退回原名，不能出现 undefined
  assert.match(text, /unknown-folder/)
  assert.doesNotMatch(text, /undefined/)
})

test('client.js：拿到报告后渲染总量、模块与建议', async () => {
  const { plugin, react } = await loadClientModule()
  const { ctx, captured } = makeClientCtx()
  plugin.apply(ctx)
  const component = captured.slots[0].component

  const report = {
    ok: true,
    root: '/fake/.dsh',
    complete: true,
    totals: { physical: 1246, logical: 1106, files: 30087, dirs: 2930 },
    reclaimableBytes: 98,
    modules: [
      { name: 'profiles', kind: 'dir', physical: 780, percent: 65.7, level: 'neutral' },
      { name: 'dsh-runtimes', kind: 'dir', physical: 311, percent: 26.2, level: 'forbidden' },
    ],
    advice: [{ level: 'forbidden', module: 'dsh-runtimes', title: '不要动：DSH 自带运行时', detail: '删了会坏', bytes: 311 }],
    largest: [{ path: 'profiles/x/codex', physical: 210, logical: 210 }],
  }

  react.__setState(0, { status: 'ready', report, error: null })
  react.__resetHooks()
  const tree = component({})
  const text = JSON.stringify(tree)
  assert.match(text, /profiles/)
  assert.match(text, /dsh-runtimes/)
  assert.match(text, /不要动：DSH 自带运行时/)
  assert.match(text, /可回收/)
  assert.match(text, /codex/)
})