#!/usr/bin/env node
// dsh-session-prep — copy-then-rewrite format-v0 logs so 0.1.5 v0→v1 can open them.
// Never writes the source tree. Default dest is <source>-prep.
import { mkdirSync, cpSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { listSessionLogs } from '../lib/scan-home.mjs'
import { readSessionLog, writeSessionLog } from '../lib/zstd-jsonl.mjs'
import { rewriteEvents, summarizeHits } from '../lib/rewrite.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i === -1 || i + 1 >= process.argv.length) return fallback
  return process.argv[i + 1]
}
function has(flag) { return process.argv.includes(flag) }

const cmd = process.argv[2] || 'help'
const sourceHome = arg('--home', join(homedir(), '.dsh'))
const destHome = arg('--out', sourceHome.replace(/\/$/, '') + '-prep')

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

function runOne(logPath, { rewrite, destPath, migrator }) {
  const { events } = readSessionLog(logPath)
  const header = events.find((e) => e && e.type === 'session') || {}
  const { events: next, hits } = rewriteEvents(events, rewrite)
  const summary = summarizeHits(hits)
  let probe = null
  if (migrator && migrator.mod && hits.length > 0) {
    const sample = next.find((_, i) => hits.some((h) => String(h.loc).includes(':' + (events[i] && events[i].seq))))
    const spliced = next.find((e) => e && e.type === 'agent/inbox/spliced')
    const target = spliced || sample || next[1]
    if (target) probe = probeEvent(migrator.mod, target)
  }
  if (rewrite && destPath) writeSessionLog(destPath, next)
  return {
    sessionId: header.id || basename(dirname(logPath)),
    cwd: header.cwd || '',
    parentSession: header.parentSession || null,
    origin: header.origin || null,
    events: events.length,
    hits: summary.count,
    byExtra: summary.byExtra,
    senders: summary.senders,
    probe,
  }
}

function printHelp() {
  console.log(`dsh-session-prep — pre-upgrade rewrite of format-v0 session logs

Commands:
  scan     [--home ~/.dsh]                 report extra source members (read-only)
  copy     [--home ~/.dsh] [--out <dir>]   copy home sessions tree (no rewrite)
  rewrite  [--home ~/.dsh] [--out <dir>]   copy + rewrite into --out (never the source)
  probe    --file <log>                    rewrite in memory + official v0→v1 assert if found

Never writes --home. rewrite always lands in --out (default: <home>-prep).

Rewrite:
  - kind:user + senderSessionId → kind:agent-message + form:relay + senderSessionId
    (official Agent Teams / send_message attribution). Other extra keys on kind:user are stripped.
  - config-only request/header missing system (inside a turn): copy the last seen
    system string forward so v2→v3 does not treat a model/effort patch as a prompt clear.
  - config-only request/header outside an open turn → model/selection
    (0.1.5 v3 restore forbids request/header between turns).
`)
}

async function main() {
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') { printHelp(); return }
  const migrator = cmd === 'probe' || has('--probe') ? await loadMigrator() : null
  if (cmd === 'scan') {
    const logs = listSessionLogs(join(sourceHome, 'sessions'))
    const rows = []
    let dirty = 0
    for (const log of logs) {
      const r = runOne(log.path, { rewrite: false, migrator: null })
      r.bytes = log.bytes
      r.project = log.project
      rows.push(r)
      if (r.hits > 0) dirty++
    }
    console.log(JSON.stringify({ home: sourceHome, sessions: logs.length, dirty, rows: rows.filter((r) => r.hits > 0) }, null, 2))
    return
  }
  if (cmd === 'copy' || cmd === 'rewrite') {
    if (destHome === sourceHome) {
      console.error('refusing to write the source home; pass --out')
      process.exit(2)
    }
    mkdirSync(destHome, { recursive: true })
    const srcSessions = join(sourceHome, 'sessions')
    const dstSessions = join(destHome, 'sessions')
    cpSync(srcSessions, dstSessions, { recursive: true })
    const report = { source: sourceHome, out: destHome, rewritten: cmd === 'rewrite', sessions: [] }
    if (cmd === 'rewrite') {
      const logs = listSessionLogs(dstSessions)
      for (const log of logs) {
        const r = runOne(log.path, { rewrite: true, destPath: log.path, migrator })
        if (r.hits > 0) report.sessions.push(r)
      }
    }
    writeFileSync(join(destHome, 'session-prep-report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ ok: true, ...report, dirty: report.sessions.length }, null, 2))
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
