import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function listSessionLogs(sessionsRoot) {
  const out = []
  let projects
  try { projects = readdirSync(sessionsRoot) } catch { return out }
  for (const proj of projects) {
    if (proj.startsWith('.')) continue
    const projDir = join(sessionsRoot, proj)
    let st
    try { st = statSync(projDir) } catch { continue }
    if (!st.isDirectory()) continue
    let ids
    try { ids = readdirSync(projDir) } catch { continue }
    for (const id of ids) {
      const log = join(projDir, id, 'session.jsonl.zstd')
      try {
        const s = statSync(log)
        if (s.isFile()) out.push({ project: proj, sessionId: id, path: log, bytes: s.size })
      } catch { /* no log */ }
    }
  }
  out.sort((a, b) => b.bytes - a.bytes)
  return out
}
