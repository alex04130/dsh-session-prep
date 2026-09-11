# dsh-session-prep

Pre-upgrade rewrite of DeepSeek Harness **format v0** session logs so the official **0.1.5** `v0→v1` migrator can open them.

The official migrator is fail-closed. A single unexpected member on `message.source` unloads the **whole** session. Plugins (mailbridge `session_send`, plasmid T-inject, meminject) wrote:

```json
{ "kind": "user", "rpcId": "…", "senderSessionId": "session-…" }
```

`kind: "user"` only admits `kind` + optional `rpcId` / `clientTimeZone`. Official attribution for a sending session is:

```json
{ "kind": "agent-message", "form": "relay", "senderSessionId": "session-…" }
```

Further mechanical rewrites for the same 0.1.2 config patches:

- Inside a turn, a `request/header` missing `system` copies the last seen `system` string forward so v2→v3 does not treat the patch as a prompt clear (`changed request prompt outside an open step`).
- Between turns, that same config-only `request/header` is rewritten to official `model/selection` (`{ provider, model, reasoningEffort? }`). 0.1.5 v3 restore forbids `request/header` outside an open turn.

This tool **copies** then rewrites. It never writes the source `$DSH_HOME`.

## Commands

```bash
# read-only: which sessions would block 0.1.5
node bin/dsh-session-prep.mjs scan --home ~/.dsh

# copy sessions tree only
node bin/dsh-session-prep.mjs copy --home ~/.dsh --out /tmp/dsh-prep

# copy + rewrite into --out
node bin/dsh-session-prep.mjs rewrite --home ~/.dsh --out /tmp/dsh-prep

# one file, in-memory rewrite + official assert if 0.1.5 migrator is on disk
node bin/dsh-session-prep.mjs probe --file /path/to/session.jsonl.zstd
```

Point 0.1.5 at `--out` (or copy rewritten logs into an isolated `$DSH_HOME`). Do not replace production logs until `session/page` on 0.1.5 is green for the copies.

## Safety

- Source tree is never opened for write.
- Rewrite is mechanical JSON. `seq` / `time` / message bodies stay. `source` members and a small set of config-only `request/header` events (type → `model/selection`, or a copied `system` string) do change.
- Child/subagent logs are rewritten the same way (they live under `sessions/<cwd-key>/<id>/`).
- On-disk Zstandard layout matches the official JSONL backend: **first frame is exactly one header line**; remaining events are independently decodable checksummed frames. A single-frame dump of the whole log is refused by 0.1.5 (`first frame is not exactly one header line`).
- Remaining migrator refusals (`replayState.kind` on old pi-ai chunks, etc.) are **not** handled here — those are official writer generations; wait for upstream or extend this tool after a measured sample.

## Measured 2026-09-10 (isolated 0.1.5-rc.2 reader)

Writer: 0.1.2-alpha.3. Reader: npm `@deepseek-ai/dsh@0.1.5-rc.2` on port 3090, isolated `$DSH_HOME`, vanilla web profile.

After rewrite of **copies** of two large sessions (`session-85a6c062…`, `session-d3404dc5…`): `session/list` ok; `session/page` through seq 80 **and** the migrated cursors (18919 / 21123) **ok**. Production originals were not moved.

Read-only `scan --home ~/.dsh` on this machine: 155 session logs, **40 dirty** (15 of them `origin: subagent`). Hits: 2077 `senderSessionId` on `kind:user`, 65 out-of-turn config headers.

## License

MIT
