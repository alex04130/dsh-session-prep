#!/usr/bin/env node
// dsh-session-prep — copy-then-rewrite format-v0 logs so 0.1.5 v0→v1 can open them.
// Never writes the source tree. Default dest is <source>-prep.
import { mkdirSync, cpSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listSessionLogs } from '../lib/scan-home.mjs'
import { readSessionLog, writeSessionLog } from '../lib/zstd-jsonl.mjs'
import { rewriteEvents, summarizeHits } from '../lib/rewrite.mjs'
import { catalogRow, renderCatalogMarkdown, renderUpgradeNotes } from '../lib/inventory.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i === -1 || i + 1 >= process.argv.length) return fallback
  return process.argv[i + 1]
}
function has(flag) { return process.argv.includes(flag) }

const cmd = process.argv[2] || 'help'
const sourceHome = resolve(arg('--home', join(homedir(), '.dsh')))
const destHome = resolve(arg('--out', sourceHome.replace(/\/$/, '') + '-prep'))

async function loadMigrator() {
  const fromArg = arg('--migrator', '')
  const candidates = [
    fromArg,
    join(homedir(), '.dsh/tmp-015-home/profiles/tmp-015/node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js'),
    join(homedir(), '.dsh/.dsh-015/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const mod = await import(pathToFileURL(p).href)
      return { path: p, mod }
    } catch (e) {
      return { path: p, error: String(e && e.message ? e.message : e) }
    }
  }
  return null
}

function probeEvent(mod, ev) {
  if (!mod || typeof mod.assertReleasedPayloadSemantics !== 'function') return { ok: null, reason: 'no-assert-export' }
  try {
    mod.assertReleasedPayloadSemantics(ev, 0)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e).slice(0, 300) }
  }
}

function runOne(logPath, { rewrite, destPath, migrator, writeIfDirtyOnly }) {
  const { events } = readSessionLog(logPath)
  const header = events.find((e) => e && e.type === 'session') || {}
  const { events: next, hits } = rewriteEvents(events, rewrite)
  const summary = summarizeHits(hits)
  let probe = null
  if (migrator && migrator.mod && hits.length > 0) {
    const spliced = next.find((e) => e && e.type === 'agent/inbox/spliced')
    const target = spliced || next[1]
    if (target) probe = probeEvent(migrator.mod, target)
  }
  const shouldWrite = rewrite && destPath && (!writeIfDirtyOnly || hits.length > 0)
  if (shouldWrite) writeSessionLog(destPath, next)
  return catalogRow(header, next, {
    sessionId: header.id || basename(dirname(logPath)),
    hits: summary.count,
    byExtra: summary.byExtra,
    senders: summary.senders,
    rewritten: Boolean(shouldWrite),
    probe,
  })
}

function printHelp() {
  console.log(`dsh-session-prep — 拷贝再改写 format-v0 会话日志（永不写源目录）

命令:
  scan     [--home ~/.dsh]                 只读扫描，列出会挡住 0.1.5 的会话
  copy     [--home ~/.dsh] [--out <dir>]   只拷 sessions 树
  rewrite  [--home ~/.dsh] [--out <dir>]   拷贝 + 全部改写
  prepare  [--home ~/.dsh] [--out <dir>]   一键整理：拷贝、只改写有问题的、出中文清单
  probe    --file <log>                    内存改写 + 官方 v0→v1 assert（若找得到迁移器）

永不写 --home。rewrite / prepare 都落在 --out（默认: <home>-prep）。

改写:
  - kind:user + senderSessionId → kind:agent-message + form:relay + senderSessionId
  - 回合内缺 system 的 request/header：补上一份 system
  - 回合间隙 config-only request/header → model/selection
  - zstd 第一帧只装 header 行

重启升级用 prepare。清单见 --out/会话清单.md 和 --out/重启升级.md。
`)
}

function assertDest() {
  if (destHome === sourceHome) {
    console.error('拒绝写入源 home；请传 --out')
    process.exit(2)
  }
}

function copySessions() {
  mkdirSync(destHome, { recursive: true })
  const srcSessions = join(sourceHome, 'sessions')
  const dstSessions = join(destHome, 'sessions')
  if (!existsSync(srcSessions)) {
    console.error('找不到 sessions 目录: ' + srcSessions)
    process.exit(2)
  }
  if (existsSync(dstSessions) && has('--fresh')) {
    rmSync(dstSessions, { recursive: true, force: true })
  }
  cpSync(srcSessions, dstSessions, { recursive: true })
  return dstSessions
}

async function main() {
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') { printHelp(); return }
  const migrator = cmd === 'probe' || has('--probe') ? await loadMigrator() : null
  if (cmd === 'scan') {
    const logs = listSessionLogs(join(sourceHome, 'sessions'))
    const rows = []
    let dirty = 0
    let i = 0
    for (const log of logs) {
      i++
      process.stderr.write(`\rscan ${i}/${logs.length}`)
      const r = runOne(log.path, { rewrite: false, migrator: null })
      r.bytes = log.bytes
      r.project = log.project
      rows.push(r)
      if (r.hits > 0) dirty++
    }
    process.stderr.write('\n')
    console.log(JSON.stringify({ home: sourceHome, sessions: logs.length, dirty, rows: rows.filter((r) => r.hits > 0) }, null, 2))
    return
  }
  if (cmd === 'copy' || cmd === 'rewrite' || cmd === 'prepare') {
    assertDest()
    const dstSessions = copySessions()
    const logs = listSessionLogs(dstSessions)
    const report = {
      source: sourceHome,
      out: destHome,
      rewritten: cmd !== 'copy',
      at: new Date().toISOString(),
      sessions: [],
      errors: [],
    }
    if (cmd === 'rewrite' || cmd === 'prepare') {
      let i = 0
      for (const log of logs) {
        i++
        process.stderr.write(`\r${cmd} ${i}/${logs.length} ${log.sessionId.slice(0, 24)}`)
        try {
          const r = runOne(log.path, {
            rewrite: true,
            destPath: log.path,
            migrator,
            writeIfDirtyOnly: cmd === 'prepare',
          })
          r.bytes = log.bytes
          r.project = log.project
          report.sessions.push(r)
        } catch (e) {
          const err = { sessionId: log.sessionId, path: log.path, error: String(e && e.message ? e.message : e).slice(0, 400) }
          report.errors.push(err)
          process.stderr.write(`\n失败 ${log.sessionId}: ${err.error}\n`)
        }
      }
      process.stderr.write('\n')
    } else {
      for (const log of logs) {
        report.sessions.push({ sessionId: log.sessionId, project: log.project, bytes: log.bytes, hits: 0, rewritten: false })
      }
    }
    const dirty = report.sessions.filter((r) => r.hits > 0).length
    writeFileSync(join(destHome, 'session-prep-report.json'), JSON.stringify({ ...report, dirty }, null, 2) + '\n')
    if (cmd === 'prepare') {
      writeFileSync(join(destHome, '会话清单.md'), renderCatalogMarkdown({ ...report, dirty }))
      writeFileSync(join(destHome, '重启升级.md'), renderUpgradeNotes(report))
    }
    const summary = {
      ok: true,
      source: sourceHome,
      out: destHome,
      sessions: report.sessions.length,
      dirty,
      rewritten: report.sessions.filter((r) => r.rewritten).length,
      errors: report.errors.length,
      mains: report.sessions.filter((r) => r.origin !== 'subagent').length,
      subagents: report.sessions.filter((r) => r.origin === 'subagent').length,
    }
    if (cmd === 'prepare') {
      summary.catalog = join(destHome, '会话清单.md')
      summary.upgrade = join(destHome, '重启升级.md')
    }
    console.log(JSON.stringify(summary, null, 2))
    if (report.errors.length) process.exitCode = 1
    return
  }
  if (cmd === 'probe') {
    const file = arg('--file', '')
    if (!file) { console.error('--file required'); process.exit(2) }
    const r = runOne(file, { rewrite: true, destPath: null, migrator: migrator && migrator.mod ? migrator : await loadMigrator() })
    r.migrator = migrator && migrator.path
    console.log(JSON.stringify(r, null, 2))
    return
  }
  printHelp()
  process.exit(2)
}

main().catch((e) => { console.error(e); process.exit(1) })
