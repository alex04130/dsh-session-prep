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
# 一键整理（推荐）：拷贝全部会话（含子代理），只改写有问题的，写出中文清单
bash scripts/prepare.sh
# 或:
node bin/dsh-session-prep.mjs prepare --home ~/.dsh --out ~/.dsh/tmp-session-prep --fresh

# Windows 双击 / 命令行:
scripts\prepare.cmd

# 只读扫描：哪些会话会挡住 0.1.5
node bin/dsh-session-prep.mjs scan --home ~/.dsh

# 只拷 sessions 树
node bin/dsh-session-prep.mjs copy --home ~/.dsh --out /tmp/dsh-prep

# 拷贝 + 全部重写（含干净日志也重压 zstd）
node bin/dsh-session-prep.mjs rewrite --home ~/.dsh --out /tmp/dsh-prep

# 单文件内存改写 + 官方 v0→v1 assert（若找得到迁移器）
node bin/dsh-session-prep.mjs probe --file /path/to/session.jsonl.zstd
```

`prepare` 产物：

- `sessions/` — 整理后的日志树（含子代理）
- `会话清单.md` — 主会话表 + 子代理按父会话分组
- `重启升级.md` — 停进程、备份、替换、启动 0.1.5 的步骤
- `session-prep-report.json` — 机器可读报告

重启升级前先看 `重启升级.md`。**不要**在 dsh 还在写日志时替换生产 `sessions/`。

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
