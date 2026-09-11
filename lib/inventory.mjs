function lastTitle(events) {
  let title = ''
  for (const ev of events) {
    if (ev && ev.type === 'session/title' && ev.data && typeof ev.data.title === 'string' && ev.data.title) {
      title = ev.data.title
    }
  }
  return title
}

function shortId(id) {
  const s = String(id || '')
  const stripped = s.startsWith('session-') ? s.slice('session-'.length) : s
  return stripped.slice(0, 8)
}

export function catalogRow(header, events, extra) {
  return {
    sessionId: header.id || extra.sessionId,
    shortId: shortId(header.id || extra.sessionId),
    title: lastTitle(events),
    cwd: header.cwd || '',
    parentSession: header.parentSession || null,
    origin: header.origin || null,
    createdAt: header.createdAt || null,
    events: events.length,
    ...extra,
  }
}

function mdEscape(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export function renderCatalogMarkdown(report) {
  const rows = report.sessions || []
  const mains = rows.filter((r) => r.origin !== 'subagent')
  const kids = rows.filter((r) => r.origin === 'subagent')
  const dirty = rows.filter((r) => r.hits > 0)
  const byParent = new Map()
  for (const k of kids) {
    const p = k.parentSession || '(无父会话)'
    if (!byParent.has(p)) byParent.set(p, [])
    byParent.get(p).push(k)
  }
  const lines = []
  lines.push('# 会话整理清单')
  lines.push('')
  lines.push(`源：\`${report.source}\``)
  lines.push(`输出：\`${report.out}\``)
  lines.push(`时间：${report.at || ''}`)
  lines.push('')
  lines.push(`- 会话总数：${rows.length}（主会话 ${mains.length}，子代理 ${kids.length}）`)
  lines.push(`- 改写过：${dirty.length}`)
  lines.push(`- 原样拷贝：${rows.length - dirty.length}`)
  lines.push('')
  lines.push('## 主会话')
  lines.push('')
  lines.push('| 短 id | 标题 | 事件 | 改写 | cwd |')
  lines.push('|---|---|---:|---|---|')
  for (const r of mains) {
    const hit = r.hits > 0 ? Object.entries(r.byExtra || {}).map(([k, v]) => `${k}×${v}`).join(', ') : '—'
    lines.push(`| \`${r.shortId}\` | ${mdEscape(r.title) || '（无标题）'} | ${r.events} | ${hit} | \`${mdEscape(r.cwd)}\` |`)
  }
  lines.push('')
  lines.push('## 子代理（按父会话）')
  lines.push('')
  if (kids.length === 0) {
    lines.push('（无）')
  } else {
    for (const [parent, list] of byParent) {
      const parentRow = rows.find((r) => r.sessionId === parent)
      const parentLabel = parentRow ? `${parentRow.shortId} ${parentRow.title || ''}`.trim() : parent
      lines.push(`### ${mdEscape(parentLabel)}`)
      lines.push('')
      lines.push('| 短 id | 事件 | 改写 |')
      lines.push('|---|---:|---|')
      for (const r of list) {
        const hit = r.hits > 0 ? Object.entries(r.byExtra || {}).map(([k, v]) => `${k}×${v}`).join(', ') : '—'
        lines.push(`| \`${r.shortId}\` | ${r.events} | ${hit} |`)
      }
      lines.push('')
    }
  }
  return lines.join('\n') + '\n'
}

export function renderUpgradeNotes(report) {
  return `# 重启升级怎么用这份整理结果

这份目录是 **拷贝**。源 \`${report.source}\` 没被改写。

## 整理了什么

- 全部会话日志（含子代理）拷到 \`sessions/\`
- 有问题的日志已机械改写（\`kind:user\`+\`senderSessionId\`、回合间隙的 config-only \`request/header\`、官方 zstd 第一帧）
- 没问题的日志原样拷贝，不重压

详见 \`会话清单.md\` 和 \`session-prep-report.json\`。

## 重启时怎么升

1. **停掉**正在跑的 dsh（主进程、隔离 3090 都停）。
2. 备份生产会话树：

   \`\`\`bash
   mv ~/.dsh/sessions ~/.dsh/sessions.bak-$(date +%Y%m%d)
   \`\`\`

3. 把整理后的会话树放回去：

   \`\`\`bash
   cp -a ${report.out}/sessions ~/.dsh/sessions
   \`\`\`

4. 再装 / 再启 0.1.5。**不要** \`npm i -g\` 覆盖正在跑的 \`/usr\`，用隔离前缀或官方安装路径。
5. 先开两份大会话看时间线。打不开就 \`mv\` 备份回去，源 v0 还在。

## 不要做的事

- 不要在 dsh 还在写日志时替换 \`sessions/\`
- 不要直接改生产树（本工具拒绝写 \`--home\`）
- 不要以为改写覆盖了所有官方拒绝（旧 pi-ai \`replayState.kind\` 仍可能挡住别的会话）
`
}