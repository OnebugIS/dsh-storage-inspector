window.__ModuleLoader__.load({
  id: 'dsh-storage-inspector',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 字典命名空间（与 cordis.patch.yml 里的行 id 无关，独立命名）。 */
    const NS = 'dsh-storage-inspector'

    const zh = {
      'storage.title': '存储',
      'storage.total': 'DSH 占用',
      'storage.reclaimable': '可回收',
      'storage.logical': '逻辑大小',
      'storage.files': '文件',
      'storage.rescan': '重新扫描',
      'storage.scanning': '扫描中…',
      'storage.loading': '正在读取磁盘占用…',
      'storage.error': '读取失败：{error}',
      'storage.forbidden': '仅本机可用',
      'storage.forbiddenDetail': '为安全起见，这张卡片只接受本机（127.0.0.1）请求。手机或局域网打开时不会显示数据。',
      'storage.modules': '按模块',
      'storage.largest': '最大的文件',
      'storage.advice': '建议',
      'storage.empty': '没有可显示的数据。',
      'storage.truncated': '扫描超时，以下数字只覆盖已扫到的部分。',
      'storage.scope': '范围：只扫 DSH 目录本身，不含工作区、项目仓库与系统其它位置。',
      'storage.units': '主动数字按磁盘块计算（与 Finder、du 一致）；逻辑大小为文件字节数之和。',
      'storage.cached': '（缓存 {age}）',
      'storage.level.safe': '可删',
      'storage.level.caution': '谨慎',
      'storage.level.forbidden': '禁止',
      'storage.module.profiles': '配置档案',
      'storage.module.dsh-runtimes': 'DSH 运行时',
      'storage.module.sessions': '会话',
      'storage.module.storages': '插件存储',
      'storage.module.attachments': '附件',
      'storage.module.cache': '缓存',
      'storage.module.backups': '备份',
      'storage.module.integrations': '集成数据',
      'storage.module.remote-web-ui-registry': '远程 Web UI 配对',
      'storage.module.im': '消息集成',
      'storage.module.bili-duty': 'B 站值班数据',
      'storage.module.llm-deepseek': '模型数据',
      'storage.module.bin': '工具脚本',
      'storage.module.task-board': '任务看板',
      'storage.module.other': '其他模块',
    }

    const en = {
      'storage.title': 'Storage',
      'storage.total': 'DSH usage',
      'storage.reclaimable': 'Reclaimable',
      'storage.logical': 'Logical size',
      'storage.files': 'Files',
      'storage.rescan': 'Rescan',
      'storage.scanning': 'Scanning…',
      'storage.loading': 'Reading disk usage…',
      'storage.error': 'Failed: {error}',
      'storage.forbidden': 'Local only',
      'storage.forbiddenDetail':
        'For safety this card only answers loopback (127.0.0.1) requests, so a phone or LAN browser sees no data.',
      'storage.modules': 'By module',
      'storage.largest': 'Largest files',
      'storage.advice': 'Advice',
      'storage.empty': 'Nothing to show.',
      'storage.truncated': 'Scan timed out; the numbers below cover only what was read.',
      'storage.scope': 'Scope: the DSH directory only — no workspaces, project repos or other system paths.',
      'storage.units': 'Primary numbers are disk-block usage (matches Finder/du); logical size is the sum of file bytes.',
      'storage.cached': '(cached {age})',
      'storage.level.safe': 'Safe',
      'storage.level.caution': 'Careful',
      'storage.level.forbidden': 'Never',
      'storage.module.profiles': 'Profiles',
      'storage.module.dsh-runtimes': 'DSH runtimes',
      'storage.module.sessions': 'Sessions',
      'storage.module.storages': 'Plugin data',
      'storage.module.attachments': 'Attachments',
      'storage.module.cache': 'Cache',
      'storage.module.backups': 'Backups',
      'storage.module.integrations': 'Integrations',
      'storage.module.remote-web-ui-registry': 'Remote pairing',
      'storage.module.im': 'Messaging',
      'storage.module.bili-duty': 'Bilibili duty data',
      'storage.module.llm-deepseek': 'Model data',
      'storage.module.bin': 'Tool scripts',
      'storage.module.task-board': 'Task board',
      'storage.module.other': 'Other',
    }

    function activeDict() {
      const lang = typeof document !== 'undefined' ? document.documentElement.lang : 'zh'
      return String(lang || 'zh').toLowerCase().startsWith('en') ? en : zh
    }

    function t(key, params) {
      let text = activeDict()[key] ?? key
      if (params) {
        for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
      }
      return text
    }

    function formatBytes(n) {
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

    const LEVEL_COLOR = {
      safe: 'var(--dsw-alias-state-success-primary, #067647)',
      caution: 'var(--dsw-alias-state-warn-primary, #b54708)',
      forbidden: 'var(--dsw-alias-state-error-primary, #b42318)',
      neutral: 'var(--dsw-alias-label-secondary, #667085)',
    }

    /** 拉一次报告；相对路径，GUI 用 <base href="./"> 提供。 */
    async function fetchReport(force) {
      const query = force ? '?force=1' : ''
      const response = await fetch(`api/storage/report${query}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const body = await response.json().catch(() => null)
      if (response.status === 403) {
        const error = new Error('forbidden')
        error.code = 403
        throw error
      }
      if (!response.ok || !body || body.ok === false) {
        throw new Error((body && body.error) || `HTTP ${response.status}`)
      }
      return body
    }

    function Bar(props) {
      const percent = Math.max(0, Math.min(100, Number(props.percent) || 0))
      return h(
        'div',
        {
          style: {
            background: 'color-mix(in srgb, currentColor 10%, transparent)',
            borderRadius: 999,
            height: 8,
            overflow: 'hidden',
            flex: '1 1 auto',
            minWidth: 80,
          },
        },
        h('div', {
          style: {
            width: `${percent}%`,
            height: '100%',
            borderRadius: 999,
            background: props.color || 'color-mix(in srgb, currentColor 55%, transparent)',
          },
        }),
      )
    }

    /**
     * 模块显示名：优先用词典里的中文名，查不到就退回目录原名。
     * 目录名本身仍然保留在 title 里，方便核对真实路径。
     */
    function moduleLabel(module) {
      const key = `storage.module.${module.name}`
      const label = activeDict()[key]
      return label === undefined ? module.name : label
    }

    function ModuleRow(props) {
      const { module } = props
      return h(
        'div',
        {
          style: {
            display: 'grid',
            gridTemplateColumns: 'minmax(110px, 190px) 1fr auto',
            alignItems: 'center',
            gap: 10,
            fontSize: 13,
            padding: '3px 0',
          },
        },
        h(
          'span',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
            title: module.name + (module.kind === 'dir' ? '/' : ''),
          },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, moduleLabel(module)),
          h('span', { style: { fontSize: 11, opacity: 0.55, flex: 'none' } }, module.name + (module.kind === 'dir' ? '/' : '')),
          module.level === 'forbidden'
            ? h('span', { style: { opacity: 0.7 }, title: t('storage.level.forbidden') }, '🔒')
            : null,
        ),
        h(Bar, { percent: module.percent, color: LEVEL_COLOR[module.level] || undefined }),
        h(
          'span',
          { style: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', opacity: 0.85 } },
          `${formatBytes(module.physical)} · ${module.percent}%`,
        ),
      )
    }

    function AdviceRow(props) {
      const { item } = props
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 8,
            alignItems: 'baseline',
            fontSize: 13,
            padding: '4px 0',
            borderTop: '1px solid color-mix(in srgb, currentColor 8%, transparent)',
          },
        },
        h(
          'span',
          {
            style: {
              flex: 'none',
              fontSize: 11,
              fontWeight: 600,
              padding: '1px 7px',
              borderRadius: 999,
              border: `1px solid ${LEVEL_COLOR[item.level] || 'currentColor'}`,
              color: LEVEL_COLOR[item.level] || 'inherit',
            },
          },
          t(`storage.level.${item.level}`),
        ),
        h(
          'span',
          { style: { flex: '1 1 auto' } },
          h('div', { style: { fontWeight: 500 } }, item.title),
          h('div', { style: { opacity: 0.7, fontSize: 12, marginTop: 1 } }, item.detail),
        ),
        h(
          'span',
          { style: { flex: 'none', fontVariantNumeric: 'tabular-nums', opacity: 0.8 } },
          formatBytes(item.bytes),
        ),
      )
    }

    function StorageSection() {
      const [state, setState] = React.useState({ status: 'loading', report: null, error: null })

      const load = React.useCallback((force) => {
        setState((prev) => ({ ...prev, status: prev.report ? 'ready' : 'loading' }))
        fetchReport(force).then(
          (report) => setState({ status: 'ready', report, error: null }),
          (error) =>
            setState({
              status: error && error.code === 403 ? 'forbidden' : 'error',
              report: null,
              error: error instanceof Error ? error.message : String(error),
            }),
        )
      }, [])

      React.useEffect(() => {
        load(false)
      }, [load])

      if (state.status === 'loading') {
        return h('div', { style: { fontSize: 13, opacity: 0.7 } }, t('storage.loading'))
      }

      if (state.status === 'forbidden') {
        return h(
          'div',
          { style: { fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 } },
          h('div', { style: { fontWeight: 600 } }, t('storage.forbidden')),
          h('div', { style: { opacity: 0.75 } }, t('storage.forbiddenDetail')),
        )
      }

      if (state.status === 'error') {
        return h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-state-error-primary, #b42318)' } },
          t('storage.error', { error: state.error || 'unknown' }))
      }

      const report = state.report
      if (!report) return h('div', { style: { fontSize: 13, opacity: 0.7 } }, t('storage.empty'))

      const totals = report.totals || {}
      const modules = Array.isArray(report.modules) ? report.modules : []
      const advice = Array.isArray(report.advice) ? report.advice : []
      const largest = Array.isArray(report.largest) ? report.largest.slice(0, 6) : []

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 16, fontSize: 13 } },

        // 总览
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 24 } },
          h(
            'div',
            null,
            h('div', { style: { fontSize: 11, opacity: 0.6 } }, t('storage.total')),
            h(
              'div',
              { style: { fontSize: 28, fontWeight: 650, fontVariantNumeric: 'tabular-nums', lineHeight: 1.15 } },
              formatBytes(totals.physical),
            ),
            h(
              'div',
              { style: { fontSize: 11, opacity: 0.55, fontVariantNumeric: 'tabular-nums' } },
              `${t('storage.logical')} ${formatBytes(totals.logical)} · ${t('storage.files')} ${Number(totals.files || 0).toLocaleString()}`,
            ),
          ),
          h(
            'div',
            null,
            h('div', { style: { fontSize: 11, opacity: 0.6 } }, t('storage.reclaimable')),
            h(
              'div',
              {
                style: {
                  fontSize: 18,
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--dsw-alias-state-success-primary, #067647)',
                },
              },
              formatBytes(report.reclaimableBytes),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => load(true),
              style: {
                marginLeft: 'auto',
                appearance: 'none',
                color: 'inherit',
                font: 'inherit',
                fontSize: 12,
                cursor: 'pointer',
                background: 'transparent',
                border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
                borderRadius: 8,
                padding: '5px 12px',
              },
            },
            t('storage.rescan'),
          ),
        ),

        report.complete === false
          ? h('div', { style: { fontSize: 12, color: LEVEL_COLOR.caution } }, t('storage.truncated'))
          : null,

        // 模块
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          h('div', { style: { fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', opacity: 0.55, marginBottom: 4 } },
            t('storage.modules')),
          ...modules.map((module) => h(ModuleRow, { key: module.name, module })),
        ),

        // 建议
        advice.length > 0
          ? h(
              'div',
              null,
              h('div', { style: { fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', opacity: 0.55, marginBottom: 4 } },
                t('storage.advice')),
              ...advice.map((item, index) => h(AdviceRow, { key: `${item.module}-${index}`, item })),
            )
          : null,

        // 最大文件
        largest.length > 0
          ? h(
              'div',
              null,
              h('div', { style: { fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', opacity: 0.55, marginBottom: 4 } },
                t('storage.largest')),
              ...largest.map((file) =>
                h(
                  'div',
                  {
                    key: file.path,
                    style: {
                      display: 'flex',
                      gap: 10,
                      justifyContent: 'space-between',
                      fontSize: 12,
                      padding: '2px 0',
                    },
                  },
                  h(
                    'span',
                    {
                      style: {
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        direction: 'rtl',
                        textAlign: 'left',
                      },
                      title: file.path,
                    },
                    file.path,
                  ),
                  h('span', { style: { flex: 'none', fontVariantNumeric: 'tabular-nums', opacity: 0.85 } },
                    formatBytes(file.physical)),
                ),
              ),
            )
          : null,

        // 脚注：范围 + 口径 + 隐私
        h(
          'div',
          { style: { fontSize: 11, opacity: 0.55, lineHeight: 1.6, borderTop: '1px solid color-mix(in srgb, currentColor 8%, transparent)', paddingTop: 8 } },
          h('div', null, t('storage.scope')),
          h('div', null, t('storage.units')),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, { zh, en })
          } catch {
            return () => {}
          }
        }, 'dsh-storage-inspector: dictionaries')

        ctx.slots.inject('settings.section', () => {
          try {
            const unregister = ctx.slots.register(
              {
                name: 'settings.section',
                id: 'dsh-storage-inspector',
                order: 152,
                label: () => {
                  try {
                    return ctx.locale.bind(NS)('storage.title')
                  } catch {
                    return t('storage.title')
                  }
                },
                locale: NS,
              },
              StorageSection,
            )
            return () => unregister()
          } catch {
            return () => {}
          }
        })
      },
    }
  },
})
