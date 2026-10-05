// dsh-cot-anchor 客户端半边：在 DSH 设置面板里挂一个「COT 锚点」标签页，
// 用来调整这个插件的全部运行时参数（判定开关 + 各项阈值），改完即时生效、
// 无需重启宿主。
//
// 格式说明：dsh 的 web client 模块必须手写 window.__ModuleLoader__.load({ id, factory })
// 壳。打包器把各插件的 client.js 原样拼进 /plugins/?? combo，不会再补函数壳；
// 若在文件顶层直接 `return {...}`，拼进 bundle 后会落在脚本顶层作用域
// → SyntaxError: Illegal return statement → 整个 client bundle 解析失败
// → 页面「Failed to load plugins」。故此处必须保持 shell 形态。
//
// 颜色：只使用 dsh 官方主题变量 --dsw-alias-*，并带深色兜底值，
// 避免主题变量缺失时退化成白底白字。
window.__ModuleLoader__.load({
  id: 'dsh-cot-anchor',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var THEME = {
      surface: 'var(--dsw-alias-bg-layer-1, #23262e)',
      surfaceRaised: 'var(--dsw-alias-bg-layer-2, #2b2f38)',
      border: 'var(--dsw-alias-border-l1, #3a3f4b)',
      borderStrong: 'var(--dsw-alias-border-l2, #4a5160)',
      text: 'var(--dsw-alias-label-primary, #e6e8ee)',
      textSecondary: 'var(--dsw-alias-label-secondary, #a8adba)',
      textTertiary: 'var(--dsw-alias-label-tertiary, #7d8391)',
      accent: 'var(--dsw-alias-brand-primary, #4a9eff)',
      accentInverted: 'var(--dsw-alias-brand-primary-invert, #ffffff)',
      danger: 'var(--dsw-alias-state-error-primary, #e0524a)',
      success: 'var(--dsw-alias-state-success-primary, #3f9d5a)'
    }

    var SETTINGS_API = '/plugins/cot-anchor/settings'
    var HARVEST_API = '/plugins/cot-anchor/harvest'

    /** 数值输入框样式（跟随主题，避免浏览器默认白底）。 */
    function numberInputStyle() {
      return {
        width: 110,
        padding: '4px 8px',
        background: THEME.surfaceRaised,
        color: THEME.text,
        border: '1px solid ' + THEME.borderStrong,
        borderRadius: 4
      }
    }

    /** 主按钮（保存）。 */
    function primaryButtonStyle(disabled) {
      return {
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        padding: '5px 18px',
        borderRadius: 4,
        border: '1px solid ' + THEME.accent,
        background: THEME.accent,
        color: THEME.accentInverted,
        fontWeight: 600
      }
    }

    /** 次要按钮（恢复默认）。 */
    function secondaryButtonStyle() {
      return {
        cursor: 'pointer',
        padding: '5px 18px',
        borderRadius: 4,
        background: THEME.surface,
        color: THEME.text,
        border: '1px solid ' + THEME.borderStrong
      }
    }

    /** 行内小按钮（候选/模式列表用）。 */
    function chipButtonStyle(tone) {
      var isPrimary = tone === 'primary'
      var isDanger = tone === 'danger'
      return {
        cursor: 'pointer',
        padding: '3px 10px',
        fontSize: 12,
        borderRadius: 4,
        background: isPrimary ? THEME.accent : THEME.surface,
        color: isPrimary ? THEME.accentInverted : (isDanger ? THEME.danger : THEME.text),
        border: '1px solid ' + (isPrimary ? THEME.accent : (isDanger ? THEME.danger : THEME.borderStrong))
      }
    }

    /** 把 0~1 的置信度渲染成百分比；非法值退回 0%。 */
    function formatConfidence(value) {
      var numeric = Number(value)
      if (!isFinite(numeric)) return '0%'
      return Math.round(numeric * 100) + '%'
    }

    /** 候选/模式共用的字段行。 */
    function metaLine(text) {
      return h('span', { style: { fontSize: 11, color: THEME.textTertiary } }, text)
    }

    /**
     * COT 采集 / 分析 / 增补面板。
     *
     * 挂在设置页原有表单下方，只做三件事：显示采集规模、手动触发一次归纳、
     * 把候选逐条交给用户采纳或忽略。所有动作都走 POST /plugins/cot-anchor/harvest，
     * 服务端把执行结果与最新状态一起回传，因此这里不需要自行推断状态。
     */
    function CotHarvestPanel() {
      var dataState = React.useState(null)
      var data = dataState[0], setData = dataState[1]
      var busyState = React.useState('')
      var busy = busyState[0], setBusy = busyState[1]
      var noticeState = React.useState('')
      var notice = noticeState[0], setNotice = noticeState[1]
      var errorState = React.useState('')
      var errorMessage = errorState[0], setErrorMessage = errorState[1]

      function load() {
        fetch(HARVEST_API)
          .then(function (res) { return res.json() })
          .then(function (body) {
            if (!body || body.ok !== true) {
              setErrorMessage('读取采集状态失败：' + ((body && body.error) || '未知错误'))
              return
            }
            setErrorMessage('')
            setData(body)
          })
          .catch(function (err) {
            setErrorMessage('读取采集状态失败：' + (err && err.message ? err.message : String(err)))
          })
      }

      React.useEffect(load, [])

      // Analysis now runs several batches per click, so the completion notice
      // reports how many samples were actually consumed and whether the
      // backlog still has more to do.
      function describeAnalyzeRun(body) {
        if (!body || typeof body.analyzed !== 'number') return ''
        var parts = ['，已分析 ' + body.analyzed + ' 条']
        if (typeof body.findings === 'number') parts.push('新增候选 ' + body.findings + ' 条')
        if (body.stoppedBy === 'budget') parts.push('已达单次时长上限，可再次点击继续')
        if (body.error) parts.push('中途停止：' + body.error)
        return parts.join('；')
      }

      function act(action, id, label) {
        setBusy(action)
        setNotice('')
        fetch(HARVEST_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action, id: id })
        })
          .then(function (res) { return res.json() })
          .then(function (body) {
            if (body) setData(body)
            if (body && body.ok === true) {
              setErrorMessage('')
              setNotice(label + '完成' + describeAnalyzeRun(body))
            } else {
              var reason = (body && body.error) || '未知错误'
              var excerpt = body && typeof body.raw === 'string' ? body.raw.trim() : ''
              if (excerpt) reason += '｜模型输出开头：' + excerpt.slice(0, 200)
              setErrorMessage(label + '失败：' + reason)
            }
          })
          .catch(function (err) {
            setErrorMessage(label + '失败：' + (err && err.message ? err.message : String(err)))
          })
          .then(function () { setBusy('') })
      }

      if (!data) {
        return h(
          'div',
          { style: { marginTop: 24, fontSize: 13, color: errorMessage ? THEME.danger : THEME.textSecondary } },
          errorMessage || '正在读取采集状态…'
        )
      }

      var proposals = data.proposals || []
      var patterns = data.patterns || []
      var shifts = data.thresholdShifts || []
      var disabled = busy !== ''

      function proposalCard(proposal) {
        var spec = proposal.featureSpec || {}
        var detail = spec.literals && spec.literals.length
          ? spec.literals.join(' / ')
          : JSON.stringify(spec)
        return h(
          'div',
          {
            key: proposal.id,
            style: {
              border: '1px solid ' + THEME.border,
              borderRadius: 6,
              padding: '10px 12px',
              marginBottom: 8,
              background: THEME.surface
            }
          },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 13, fontWeight: 600, color: THEME.text } }, proposal.title || proposal.id),
            metaLine(proposal.detector + ' · ' + proposal.kind + ' · 置信 ' + formatConfidence(proposal.confidence) + ' · 独立发现 ' + (proposal.seenCount || 1) + ' 次')
          ),
          proposal.observation
            ? h('div', { style: { fontSize: 12, color: THEME.textSecondary, marginTop: 4, lineHeight: 1.6 } }, proposal.observation)
            : null,
          h(
            'div',
            { style: { fontSize: 11, color: THEME.textTertiary, marginTop: 4, fontFamily: 'monospace', wordBreak: 'break-all' } },
            detail
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 8 } },
            h('button', { style: chipButtonStyle('primary'), disabled: disabled, onClick: function () { act('approve', proposal.id, '采纳') } }, '采纳'),
            h('button', { style: chipButtonStyle(), disabled: disabled, onClick: function () { act('reject', proposal.id, '忽略') } }, '忽略')
          )
        )
      }

      function patternCard(pattern, index) {
        var isShadow = pattern.mode === 'shadow'
        var hits = pattern.shadowHits || 0
        var ready = isShadow && data.shadowRounds > 0 && hits >= data.shadowRounds
        return h(
          'div',
          {
            key: pattern.id || index,
            style: {
              border: '1px solid ' + THEME.border,
              borderRadius: 6,
              padding: '10px 12px',
              marginBottom: 8,
              background: THEME.surface,
              opacity: pattern.enabled === false ? 0.55 : 1
            }
          },
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 13, fontWeight: 600, color: THEME.text } }, pattern.literal || pattern.title || pattern.id),
            metaLine(pattern.detector + ' · ' + (isShadow ? '影子期（只计数）' : '已生效') + (isShadow ? ' · 本会打断 ' + hits + ' 次' : '')),
            ready ? metaLine('已达影子期阈值，可转正') : null
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 8 } },
            isShadow
              ? h('button', { style: chipButtonStyle('primary'), disabled: disabled, onClick: function () { act('promote', pattern.id, '转正') } }, '转正')
              : null,
            pattern.enabled === false
              ? h('button', { style: chipButtonStyle(), disabled: disabled, onClick: function () { act('enable', pattern.id, '启用') } }, '启用')
              : h('button', { style: chipButtonStyle(), disabled: disabled, onClick: function () { act('disable', pattern.id, '停用') } }, '停用'),
            h('button', { style: chipButtonStyle('danger'), disabled: disabled, onClick: function () { act('delete', pattern.id, '删除') } }, '删除')
          )
        )
      }

      return h(
        'div',
        { style: { marginTop: 26, paddingTop: 18, borderTop: '1px solid ' + THEME.border, maxWidth: 720 } },
        h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, 'COT 静默采集与经验增补'),
        h(
          'div',
          { style: { color: THEME.textTertiary, fontSize: 12, lineHeight: 1.6, marginBottom: 12 } },
          '采集真实思考样本 → 交给模型归纳「现有检测器看不见」的打转形态 → 你逐条采纳后进入运行时叠加。',
          '默认关闭；关闭时零采集、零额外调用、零磁盘写入。学习到的模式首次生效先进入影子期，只统计「本会打断」的次数，不真的打断。'
        ),

        errorMessage ? h('div', { style: { color: THEME.danger, fontSize: 12, marginBottom: 8 } }, errorMessage) : null,
        notice ? h('div', { style: { color: THEME.success, fontSize: 12, marginBottom: 8 } }, notice) : null,
        !data.enabled
          ? h('div', { style: { color: THEME.textTertiary, fontSize: 12, marginBottom: 8 } }, '当前采集开关为关闭，下面的计数不会增长。')
          : null,

        h(
          'div',
          {
            style: {
              display: 'flex',
              gap: 16,
              flexWrap: 'wrap',
              fontSize: 12,
              color: THEME.textSecondary,
              background: THEME.surface,
              border: '1px solid ' + THEME.border,
              borderRadius: 6,
              padding: '10px 12px',
              marginBottom: 10
            }
          },
          h('span', null, '样本 ' + (data.samples || 0) + ' 条'),
          h('span', null, '未分析 ' + (data.pending || 0) + ' 条'),
          h('span', null, '待审候选 ' + proposals.length + ' 条'),
          h('span', null, '已采纳 ' + patterns.length + ' 条' + (shifts.length ? ' + 阈值调整 ' + shifts.length + ' 项' : '')),
          h('span', null, data.analyzing ? '分析进行中…' : '空闲')
        ),

        h(
          'div',
          { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 } },
          h('button', { style: primaryButtonStyle(disabled), disabled: disabled, onClick: function () { act('analyze', '', '分析') } }, busy === 'analyze' ? '分析中…' : '立即分析'),
          h('button', { style: secondaryButtonStyle(), disabled: disabled, onClick: function () { act('export', '', '导出增补请求包') } }, '导出增补请求包'),
          h('button', { style: secondaryButtonStyle(), disabled: disabled, onClick: function () { load(); setNotice('') } }, '刷新状态'),
          h('button', { style: secondaryButtonStyle(), disabled: disabled, onClick: function () { act('clear', '', '清空样本') } }, '清空样本')
        ),

        h('div', { style: { fontSize: 13, fontWeight: 600, color: THEME.textSecondary, marginBottom: 6 } }, '待审候选'),
        proposals.length === 0
          ? h('div', { style: { fontSize: 12, color: THEME.textTertiary, marginBottom: 14 } }, '暂无候选。先在设置里打开采集，攒够样本后点「立即分析」。')
          : h('div', { style: { marginBottom: 14 } }, proposals.map(proposalCard)),

        h('div', { style: { fontSize: 13, fontWeight: 600, color: THEME.textSecondary, marginBottom: 6 } }, '已采纳的学习模式'),
        patterns.length === 0
          ? h('div', { style: { fontSize: 12, color: THEME.textTertiary } }, '暂无。采纳候选后出现在这里，可随时停用或删除。')
          : h('div', null, patterns.map(patternCard)),

        data.paths
          ? h(
            'div',
            { style: { fontSize: 11, color: THEME.textTertiary, marginTop: 12, lineHeight: 1.7, fontFamily: 'monospace', wordBreak: 'break-all' } },
            '样本 ' + data.paths.samples + '\n候选 ' + data.paths.proposals + '\n叠加 ' + data.paths.patterns
          )
          : null
      )
    }

    function apply(ctx) {
      var slots = ctx.slots

      slots.inject('settings.section', function () {
        slots.register(
          { name: 'settings.section', id: 'cot-anchor', label: 'COT 锚点', order: 998 },
          function CotAnchorSettings() {
            var state = React.useState(null)
            var payload = state[0], setPayload = state[1]
            var draftState = React.useState({})
            var draft = draftState[0], setDraft = draftState[1]
            var loadingState = React.useState(true)
            var loading = loadingState[0], setLoading = loadingState[1]
            var savingState = React.useState(false)
            var saving = savingState[0], setSaving = savingState[1]
            var noticeState = React.useState('')
            var notice = noticeState[0], setNotice = noticeState[1]
            var errorState = React.useState('')
            var errorMessage = errorState[0], setErrorMessage = errorState[1]

            function load() {
              fetch(SETTINGS_API)
                .then(function (res) { return res.json() })
                .then(function (body) {
                  if (!body || body.ok !== true) {
                    setErrorMessage('读取设置失败：' + ((body && body.error) || '未知错误'))
                  } else {
                    setPayload(body)
                    setDraft(Object.assign({}, body.settings))
                    setErrorMessage('')
                  }
                  setLoading(false)
                })
                .catch(function (err) {
                  setErrorMessage('读取设置失败：' + (err && err.message ? err.message : String(err)))
                  setLoading(false)
                })
            }

            React.useEffect(load, [])

            function persist(next) {
              setSaving(true)
              setNotice('')
              fetch(SETTINGS_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings: next })
              })
                .then(function (res) { return res.json() })
                .then(function (body) {
                  if (!body || body.ok !== true) {
                    setErrorMessage('保存失败：' + ((body && body.error) || '未知错误'))
                    return
                  }
                  setErrorMessage('')
                  setDraft(Object.assign({}, body.settings))
                  setPayload(function (prev) {
                    return Object.assign({}, prev, { settings: body.settings })
                  })
                  setNotice(body.saved === false ? '已生效，但写入配置文件失败（重启后会恢复）' : '已保存并即时生效')
                })
                .catch(function (err) {
                  setErrorMessage('保存失败：' + (err && err.message ? err.message : String(err)))
                })
                .then(function () { setSaving(false) })
            }

            if (loading) {
              return h('div', { style: { padding: 16, color: THEME.textSecondary } }, '正在读取设置…')
            }
            if (!payload) {
              return h('div', { style: { padding: 16, color: THEME.danger } }, errorMessage || '设置不可用')
            }

            var schema = payload.schema || []
            var capabilities = payload.capabilities || {}

            /**
             * 能力提示条 —— 把"当前内核是否有掐断能力"直接摆在设置页顶部。
             *
             * 背景：截停能力挂在宿主钩子 agent/soft-cut 上，上游自 0.1.5-rc.3 起
             * 已移除。此前该失效完全静默（插件不报错、日志正常），只能等故障倒推。
             * 这里把探测结果明示出来，让"能力没了"一眼可见。
             */
            function renderCapabilityBanner() {
              var state = capabilities.softCut
              if (!state) return null
              var config
              if (state === 'present') {
                config = {
                  color: THEME.success,
                  title: '掐断能力正常',
                  body: '当前内核提供宿主钩子 ' + (capabilities.softCutHook || 'agent/soft-cut') + '，生成中途截停可正常工作。'
                }
              } else if (state === 'absent') {
                config = {
                  color: THEME.danger,
                  title: '当前内核没有掐断能力',
                  body: '宿主钩子 ' + (capabilities.softCutHook || 'agent/soft-cut') +
                    ' 不存在（上游自 0.1.5-rc.3 起移除）。下方「打断判定」区的全部选项本次都不会生效 —— ' +
                    '模型打转或把工具调用写进正文时，不会被自动截停，只能手动中断。' +
                    '「工具结果后注入锚点」不受影响，仍然正常工作。'
                }
              } else {
                config = {
                  color: THEME.textSecondary,
                  title: '无法确认掐断能力',
                  body: '未能读取内核源码来判断宿主钩子是否存在。若该钩子已被移除，' +
                    '「打断判定」区的选项会静默失效；请以实际运行表现为准。'
                }
              }
              return h(
                'div',
                {
                  style: {
                    border: '1px solid ' + config.color,
                    borderRadius: 6,
                    padding: '8px 12px',
                    marginBottom: 12,
                    fontSize: 12,
                    lineHeight: 1.6
                  }
                },
                h('div', { style: { color: config.color, fontWeight: 600, marginBottom: 2 } }, config.title),
                h('div', { style: { color: THEME.textSecondary } }, config.body)
              )
            }
            // 按 group 聚合，保持 schema 中的先后顺序
            var groups = []
            schema.forEach(function (entry) {
              var group = entry.group || '其他'
              var found = null
              groups.forEach(function (item) { if (item.name === group) found = item })
              if (!found) {
                found = { name: group, entries: [] }
                groups.push(found)
              }
              found.entries.push(entry)
            })

            function setValue(key, value) {
              setDraft(function (prev) {
                var next = Object.assign({}, prev)
                next[key] = value
                return next
              })
              setNotice('')
            }

            function renderRow(entry) {
              var value = draft[entry.key]
              var control
              if (entry.type === 'boolean') {
                control = h('input', {
                  type: 'checkbox',
                  checked: value !== false,
                  style: { width: 16, height: 16, cursor: 'pointer', accentColor: THEME.accent },
                  onChange: function (event) { setValue(entry.key, event.target.checked) }
                })
              } else if (entry.type === 'text') {
                control = h('input', {
                  type: 'text',
                  value: value === undefined || value === null ? '' : value,
                  placeholder: entry.placeholder || '',
                  style: {
                    width: 240,
                    padding: '4px 8px',
                    background: THEME.surfaceRaised,
                    color: THEME.text,
                    border: '1px solid ' + THEME.borderStrong,
                    borderRadius: 4
                  },
                  onChange: function (event) { setValue(entry.key, event.target.value) }
                })
              } else {
                control = h('input', {
                  type: 'number',
                  value: value === undefined || value === null ? '' : value,
                  min: entry.min,
                  max: entry.max,
                  style: numberInputStyle(),
                  onChange: function (event) {
                    var raw = event.target.value
                    setValue(entry.key, raw === '' ? '' : Number(raw))
                  }
                })
              }
              return h(
                'div',
                {
                  key: entry.key,
                  style: {
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: '8px 0',
                    borderBottom: '1px solid ' + THEME.border
                  }
                },
                h(
                  'div',
                  { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { color: THEME.text, fontSize: 13 } }, entry.label),
                  entry.hint
                    ? h('div', { style: { color: THEME.textTertiary, fontSize: 12, marginTop: 2, lineHeight: 1.5 } }, entry.hint)
                    : null,
                  entry.hint && entry.type !== 'boolean'
                    ? h('div', { style: { color: THEME.textTertiary, fontSize: 12, marginTop: 2 } }, '范围 ' + entry.min + ' ~ ' + entry.max)
                    : null
                ),
                h('div', { style: { flexShrink: 0, paddingTop: 2 } }, control)
              )
            }

            return h(
              'div',
              { style: { padding: '16px 20px', color: THEME.text, maxWidth: 720 } },
              h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, 'COT 锚点'),
              h(
                'div',
                { style: { color: THEME.textTertiary, fontSize: 12, lineHeight: 1.6, marginBottom: 12 } },
                '控制"结论锚点注入"与"打转打断"的判定方式。阈值调低会让判定更激进（更早打断，但误判风险更高）。设置改动即时生效，无需重启。'
              ),

              errorMessage
                ? h('div', { style: { color: THEME.danger, fontSize: 12, marginBottom: 8 } }, errorMessage)
                : null,
              renderCapabilityBanner(),
              notice
                ? h('div', { style: { color: THEME.success, fontSize: 12, marginBottom: 8 } }, notice)
                : null,

              groups.map(function (group) {
                return h(
                  'div',
                  { key: group.name, style: { marginBottom: 18 } },
                  h(
                    'div',
                    { style: { fontSize: 13, fontWeight: 600, color: THEME.textSecondary, marginBottom: 4 } },
                    group.name
                  ),
                  h(
                    'div',
                    {
                      style: {
                        background: THEME.surface,
                        border: '1px solid ' + THEME.border,
                        borderRadius: 6,
                        padding: '0 12px'
                      }
                    },
                    group.entries.map(renderRow)
                  )
                )
              }),

              h(
                'div',
                { style: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 } },
                h(
                  'button',
                  { style: primaryButtonStyle(saving), disabled: saving, onClick: function () { persist(draft) } },
                  saving ? '保存中…' : '保存'
                ),
                h(
                  'button',
                  {
                    style: secondaryButtonStyle(),
                    onClick: function () { setDraft(Object.assign({}, payload.defaults || {})); setNotice('已填入默认值，点「保存」生效') }
                  },
                  '恢复默认'
                ),
                h(
                  'button',
                  {
                    style: secondaryButtonStyle(),
                    onClick: function () { load(); setNotice('') }
                  },
                  '重新读取'
                )
              ),

              h(CotHarvestPanel)
            )
          }
        )
      })
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  }
})
