// Pre-upgrade rewrite of format-v0 event sources so 0.1.5 v0→v1 migrator accepts them.
// Official legal attribution for a sending session is { kind: 'agent-message', form: 'relay', senderSessionId }.
// kind:'user' only admits kind + optional rpcId / clientTimeZone.

export const USER_ALLOWED = new Set(['kind', 'rpcId', 'clientTimeZone'])

function walkMessage(msg, loc, hits, rewrite) {
  if (msg === null || typeof msg !== 'object') return msg
  const src = msg.source
  if (src === null || typeof src !== 'object') return msg
  if (src.kind !== 'user') return msg
  const extra = Object.keys(src).filter((k) => !USER_ALLOWED.has(k))
  if (extra.length === 0) return msg
  const sender = typeof src.senderSessionId === 'string' ? src.senderSessionId : ''
  hits.push({ loc, extra, sender, rpcId: src.rpcId })
  if (!rewrite) return msg
  if (sender !== '') {
    return {
      ...msg,
      source: { kind: 'agent-message', form: 'relay', senderSessionId: sender },
    }
  }
  const next = { kind: 'user' }
  if (typeof src.rpcId === 'string') next.rpcId = src.rpcId
  if (typeof src.clientTimeZone === 'string') next.clientTimeZone = src.clientTimeZone
  return { ...msg, source: next }
}

function isConfigPatchHeader(header) {
  if (header === null || typeof header !== 'object') return false
  const keys = Object.keys(header)
  if (keys.length === 0) return false
  for (const k of keys) {
    if (k !== 'config' && k !== 'system' && k !== 'tools' && k !== 'adapterDefaults') return false
  }
  const cfg = header.config
  if (cfg === null || typeof cfg !== 'object') return false
  return typeof cfg.provider === 'string' && typeof cfg.model === 'string'
}

function toModelSelection(ev, header) {
  const cfg = header.config
  const data = { provider: cfg.provider, model: cfg.model }
  if (typeof cfg.reasoningEffort === 'string') data.reasoningEffort = cfg.reasoningEffort
  return { ...ev, type: 'model/selection', data }
}

/**
 * 0.1.2 writers emit config-only request/header (model/effort) with no `system`.
 * Two later 0.1.5 refusals follow from that:
 * - v2→v3 treats absent system as the empty prompt; a change outside an open
 *   step refuses the Session. Carry the last seen system string forward when
 *   the header stays a request/header inside a turn.
 * - v3 restore then forbids request/header outside an open turn. Convert those
 *   config patches to official model/selection (legal between turns).
 */
export function rewriteRequestHeader(ev, state, hits, rewrite) {
  if (ev === null || typeof ev !== 'object') return ev
  const t = ev.type
  if (t === 'turn/start') state.openTurn = true
  else if (t === 'turn/end') { state.openTurn = false; state.open = false }
  else if (t === 'step/start') state.open = true
  else if (t === 'step/end') state.open = false
  if (t !== 'request/header') return ev
  const data = ev.data
  if (data === null || typeof data !== 'object') return ev
  const header = data.header
  if (header === null || typeof header !== 'object') return ev
  if (Object.hasOwn(header, 'system') && typeof header.system === 'string') {
    state.lastSystem = header.system
  }
  if (!state.openTurn && isConfigPatchHeader(header)) {
    hits.push({
      loc: `request/header:${ev.seq}`,
      extra: ['out-of-turn-header'],
      sender: '',
      open: false,
    })
    if (!rewrite) return ev
    return toModelSelection(ev, header)
  }
  if (Object.hasOwn(header, 'system') && typeof header.system === 'string') return ev
  const last = typeof state.lastSystem === 'string' ? state.lastSystem : ''
  if (last === '') return ev
  hits.push({
    loc: `request/header:${ev.seq}`,
    extra: ['missing-system'],
    sender: '',
    open: state.open,
    lastLen: last.length,
  })
  if (!rewrite) return ev
  return {
    ...ev,
    data: {
      ...data,
      header: { ...header, system: last },
    },
  }
}

export function rewriteEvent(ev, hits, rewrite) {
  if (ev === null || typeof ev !== 'object') return ev
  const t = ev.type
  const data = ev.data
  if (data === null || typeof data !== 'object') return ev
  const seq = ev.seq
  let changed = false
  let nextData = data

  if (t === 'agent/inbox/spliced' && Array.isArray(data.inserted)) {
    const inserted = data.inserted.map((m, i) => {
      const out = walkMessage(m, `spliced:${seq}[${i}]`, hits, rewrite)
      if (out !== m) changed = true
      return out
    })
    if (changed) nextData = { ...data, inserted }
  }

  if (t === 'user/message' || t === 'assistant/message' || t === 'tool/result' || t === 'steering/message') {
    const msg = data.message !== null && typeof data.message === 'object' ? data.message : data
    const out = walkMessage(msg, `${t}:${seq}`, hits, rewrite)
    if (out !== msg) {
      changed = true
      if (data.message !== null && typeof data.message === 'object') nextData = { ...data, message: out }
      else nextData = { ...data, ...out }
    }
  }

  return changed ? { ...ev, data: nextData } : ev
}

export function rewriteEvents(events, rewrite) {
  const hits = []
  const state = { open: false, openTurn: false, lastSystem: '' }
  const out = events.map((ev) => {
    const afterSource = rewriteEvent(ev, hits, rewrite)
    return rewriteRequestHeader(afterSource, state, hits, rewrite)
  })
  return { events: out, hits, changed: hits.length }
}

export function summarizeHits(hits) {
  const byExtra = {}
  const senders = {}
  for (const h of hits) {
    const k = h.extra.join(',')
    byExtra[k] = (byExtra[k] || 0) + 1
    if (h.sender) senders[h.sender] = (senders[h.sender] || 0) + 1
  }
  return { count: hits.length, byExtra, senders: Object.keys(senders).length }
}
