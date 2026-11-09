# ComfyUI Light MCP

[简体中文](README.zh-CN.md) · MIT · Candidate **0.3.0-rc.1** (not published)

A local stdio MCP server for running trusted ComfyUI workflows from an AI client.

- **Workflow-first:** export an API graph once; a manifest exposes only approved parameters. The client does not send large graphs on every call.
- **Batch-native:** one call submits up to 200 labeled runs, with persistent jobs, bounded scheduling, idempotency keys and conservative recovery.
- **Context-light:** four tools return summaries and paginated status; a local JSONL index delivers every result without filling the conversation with logs or image data. This describes the interface, not a guaranteed token or cost saving.

Requires Windows 11 x64 and **Node.js 22.12+** (tested: 22.22.0). ComfyUI must be installed and running separately. The tested backend is ComfyUI 0.41.0; other versions and Windows ARM64 have not been verified. This server does not install models, nodes or ComfyUI.

## Install on Windows

Use PowerShell in a source checkout of this candidate:

```powershell
npm ci
npm run build
Copy-Item config.env.example config.env
node --env-file=config.env dist/index.js
```

`npm install` is also supported; `npm ci` uses the committed lockfile. `better-sqlite3` must load a native addon matching your Node version and architecture. Normal Windows x64 installations use its prebuilt binary; if unavailable, compilation requires Python and Visual Studio C++ Build Tools. Do not install with `--ignore-scripts` or copy another machine's `node_modules`.

For a local package handoff (no registry publication):

```powershell
# In the source checkout; prepack builds dist automatically.
npm pack
# In a separate, newly created installation directory:
npm init -y
npm install --omit=dev C:/handoff/comfyui-light-mcp-0.3.0-rc.1.tgz
Copy-Item node_modules/comfyui-light-mcp/config.env.example config.env
Copy-Item -Recurse node_modules/comfyui-light-mcp/examples workflows
# Set WORKFLOWS_DIR=./workflows in config.env before launching.
node --env-file=config.env node_modules/comfyui-light-mcp/dist/index.js
```

`C:/handoff` is an example destination; replace it with your own path. The installed command `comfyui-light-mcp` is also available through npm's local bin. MCP clients must launch `node` directly as shown below so npm's startup messages do not enter stdout. A terminal launch waits for MCP JSON-RPC input; it is not an interactive CLI.

## Configuration

Edit `config.env`; Node's `--env-file` loads it. There is no automatic `.env` discovery or configuration wizard. Explicit environment variables take precedence over the env file. Keep personal configuration outside version control.

| Variable | Default | Meaning |
|---|---|---|
| `COMFYUI_URL` | `http://127.0.0.1:8188` | Existing HTTP(S) ComfyUI endpoint; HTTP and WebSocket must both be reachable |
| `WORKFLOWS_DIR` | `./workflows` | Recursively scanned at startup for `*.manifest.json` |
| `DATA_DIR` | `./data` | Persistent SQLite directory; created at startup |
| `OUTPUT_DIR` | `./output` | Downloaded outputs and JSONL indexes |
| `AUTO_SAVE_OUTPUTS` | `true` | Download outputs on completion; `false` defers to `get_result` |
| `MAX_IN_FLIGHT` | `1` | In-flight jobs, 1–64; unknown submissions retain their slot |
| `MAX_QUEUED_JOBS` | `1` | Queued jobs, 1–64 and no greater than `MAX_IN_FLIGHT` |
| `JOB_TIMEOUT_MS` | `600000` | Wall-clock job deadline, 10000–86400000 milliseconds |

Boolean values accept `true/false/1/0`. Relative paths resolve against the process working directory, not the env file. The sample env uses `./examples` for an immediate model-free installation check; real installations should use a dedicated workflows directory. For MCP clients use absolute directories. Use one MCP process per database, and keep ComfyUI on a trusted local network; there is no server authentication configuration.

## Workflows and manifests

In ComfyUI, enable developer options if your frontend requires it, then save/export the workflow in **API format**. Menu wording varies by frontend version. An API graph maps node IDs to `class_type` and `inputs`; the visual editor JSON containing `nodes` and `links` is not suitable. If wrapped, the loader accepts `{ "prompt": { ... } }` too. Place the exported graph and its manifest together inside `WORKFLOWS_DIR`, then restart the MCP server.

The included `examples/solid-color.json` uses only built-in `EmptyImage` → `SaveImage`, needs no model and creates a small PNG. Its companion manifest exposes `color`, `width` and `height`. A minimal manifest looks like this:

```json
{
  "name": "solid-color",
  "description": "Built-in ComfyUI installation check",
  "version": 1,
  "workflowFile": "solid-color.json",
  "params": [
    { "name": "color", "node": "1", "input": "color", "type": "integer", "min": 0, "max": 16777215, "default": 255 }
  ]
}
```

Names start with a letter and use letters, digits, `_` or `-` (up to 64 characters). `workflowFile` is a filename in the same directory. At least one parameter is required. Parameters target an existing scalar input, never a graph link. Types are `string`, `number`, `integer`, `boolean`, `enum`; enums require a nonempty string `enum` array. Optional numeric bounds and `step` are checked; `step` is relative to `min`, or zero when omitted. `required: true` and `default` are mutually exclusive. Without either, omission keeps the graph's existing input. Integer seeds can use `special: "seed"` with `default: -1`; actual random seeds are persisted in resolved parameters.

Unlisted parameters are rejected. Nodes, model names and graph validity are ultimately checked by ComfyUI. Review imported graphs and custom nodes before use. Batch fingerprints prevent pending work from silently using an edited graph or manifest: keep original pairs to resume existing work; intentional changes should use a new workflow name and a new batch.

## Four MCP tools

| Tool | Use |
|---|---|
| `list_workflows` | List workflow summaries; pass `workflow` for parameter details |
| `run_workflow` | Submit `params` for one job or `runs` for a batch; returns a batch handle immediately |
| `get_batch` | Poll state counts and paginated jobs; `limit` defaults to 20, maximum 100; use `offset` and optional `status` |
| `get_result` | Read one result (`index`, default 0) or write the batch JSONL index (`mode: "index"`) |

Tool arguments (send these through an MCP client, not the terminal):

```json
{"workflow":"solid-color"}
```

Use that with `list_workflows`, then call `run_workflow`:

```json
{"workflow":"solid-color","params":{"color":255},"idempotency_key":"single-demo-1"}
```

Batch submission to `run_workflow`:

```json
{
  "workflow": "solid-color",
  "idempotency_key": "colors-demo-1",
  "continue_on_error": true,
  "max_attempts": 1,
  "runs": [
    { "label": "blue", "params": { "color": 255 } },
    { "label": "green", "params": { "color": 65280 } },
    { "label": "red", "params": { "color": 16711680 } }
  ]
}
```

`params` and `runs` are mutually exclusive. The same key and identical request return the existing batch; reusing a key with different content returns `IDEMPOTENCY_CONFLICT`. A batch records invalid runs independently. `continue_on_error` and `max_attempts` apply to the `runs` form; retries are only allowed after confirmed remote failure. Defaults are continue on error and one attempt. Unknown remote outcomes are not automatically resubmitted.

Poll `get_batch`:

```json
{"batch_id":"<returned batch_id>","limit":20,"offset":0}
```

Use bounded polling, for example every 1–2 seconds, with a client-side deadline. `unknown` and `paused` are separate from failed counts. When work terminates, request `get_result`:

```json
{"batch_id":"<returned batch_id>","mode":"index","download":true}
```

The response contains counters, `complete`, `unavailable_outputs`, `index_path` and `updated_at`. The local `OUTPUT_DIR/<batch_id>/results.jsonl` has one row per original job, ordered by index, including label, status, actual seed when available, all outputs and concise errors. Each output includes availability, bytes and a usable absolute `local_path` when present. The client needs separate permission to read local files; this MCP server does not provide a file-reading tool. For a remotely hosted MCP process, paths belong to that host.

`complete` means execution is terminal, not that all files are present: also check `unavailable_outputs === 0`. Re-requesting retries missing downloads without generating images again. `download: false` only indexes locally available files. The index is the latest snapshot, not immutable history. For single-job details use `{"batch_id":"<id>","index":0,"download":true}` to get resolved parameters and outputs.

## Input assets

Upload source images/audio/video through ComfyUI's own interface, or copy them into the configured **ComfyUI input directory**. Expose the relevant `LoadImage` or other loader filename as a manifest string parameter (for example `"image": "source.png"`). Filenames are resolved by ComfyUI, not by the MCP machine. Keep asset names and workflow versions stable while batches are pending. This version has no upload tool, arbitrary URL fetch or model manager; backing up the SQLite database does not back up input media.

## MCP client setup

Example generic MCP client configuration; replace every `C:/mcp/...` placeholder with your own absolute path. Put these values in the client's settings, not in a public repository.

```json
{
  "mcpServers": {
    "comfyui-light": {
      "command": "node",
      "args": ["C:/mcp/comfyui-light-mcp/dist/index.js"],
      "env": {
        "COMFYUI_URL": "http://127.0.0.1:8188",
        "WORKFLOWS_DIR": "C:/mcp/workflows",
        "DATA_DIR": "C:/mcp/data",
        "OUTPUT_DIR": "C:/mcp/output"
      }
    }
  }
}
```

For a tarball installation, point `args` into `node_modules/comfyui-light-mcp/dist/index.js`. If the client cannot find Node, use its absolute executable path. Startup diagnostics go to stderr; stdout is reserved for MCP. Client disconnect/EOF or SIGINT/SIGTERM stops local scheduling, closes sockets and closes SQLite; this does not cancel remote generation. Recovery reconciles persisted jobs on restart.

## SQLite, upgrades and backups

State lives at `DATA_DIR/comfyui-light.db` using WAL. Keep the whole DATA_DIR on a local writable disk; do not share one database between simultaneous MCP processes. Schema v1–v4 (including the experimental P4.1 variants) migrates transactionally to v5. Historical pending jobs without workflow fingerprints are paused; unconfirmed previous attempts reconcile before retry. Reopening v5 is idempotent. Newer unknown schemas are rejected. v5 triggers reject writes from older application connections; do not remove the guards.

Before upgrading, stop the MCP client process and wait for its exit. Then copy the entire DATA_DIR, including any `-wal` and `-shm` files, while no process writes it. For a live database use SQLite's online backup API instead of copying only the `.db` file. Retain OUTPUT_DIR, workflow/manifest pairs and ComfyUI inputs separately. Example consistent online backup, run in the installed package directory:

```powershell
node --input-type=module -e 'import Database from "better-sqlite3"; const db = new Database(process.argv[1], {readonly:true}); try { await db.backup(process.argv[2]); } finally { db.close(); }' C:/mcp/data/comfyui-light.db C:/mcp/backups/before-upgrade.db
```

Create the backup directory first and choose a new filename. This makes a separate backup, never changes the schema. Restore or roll back using the appropriate backup in an independent DATA_DIR; an older binary must not write the upgraded database. Unknown remote jobs need reconciliation before new submissions, including after restoring a backup.

## Troubleshooting and current limits

| Symptom | Action |
|---|---|
| Native addon missing / ABI mismatch | Use Node 22 x64, run `npm ci` again; allow install scripts and access to prebuilt binaries, or provide the native build tools |
| No workflows / startup load errors | Set the correct directory; use API JSON plus a matching manifest; restart after edits |
| `COMFY_UNREACHABLE` or jobs remain pending | Confirm the ComfyUI URL, HTTP and WebSocket connectivity; the MCP server can start while ComfyUI is offline |
| `INVALID_PARAMS` / `COMFY_REJECTED` | Check manifest bounds and parameter names; inspect node error summaries for missing models, nodes or unsupported enum values |
| `submission_unknown` / `paused` | Preserve DB and backend history; restore connectivity or the original workflow pair; do not force database status changes or blindly resubmit |
| Index complete but missing files | Inspect `unavailable_outputs` and JSONL availability; restore ComfyUI outputs and retry `get_result`; unsafe paths remain rejected |
| Client protocol parse errors | Launch `node .../dist/index.js` directly; avoid npm banners or other stdout output |
| SQLite locked or migration failure | Stop duplicate processes, verify directory permissions and restore a consistent backup if needed; preserve the original database |

Single trusted local instance; stdio transport only. No GUI, authentication options, workflow editing, hot reload, upload tool, cancellation tool, cloud orchestration or distributed scheduler. A batch contains at most 200 jobs. Recovery requires backend queue/history and can remain unresolved if that evidence was removed. Output collection depends on ComfyUI history exposing downloadable file references; custom node output formats may differ. Seeds alone do not guarantee reproducibility across models, nodes, devices or versions. Data, outputs and indexes have no automatic retention cleanup. Keep backups and manage disk space yourself.

## Development and package boundary

```powershell
npm run build
npm run typecheck
npm run lint
npm test -- --fileParallelism=false
npm pack --dry-run
```

Existing real-backend tests run when `COMFYUI_URL` is reachable and can submit or interrupt work. Run them only against an isolated test backend; use `COMFYUI_URL=http://127.0.0.1:1` for offline regression. The package allowlist includes runtime JavaScript, the model-free example, sample configuration, both READMEs and licenses. It excludes source tests, benchmarks, images, databases, logs and personal configuration. Source acceptance reports stay in `docs/`. See LICENSE, NOTICE and THIRD_PARTY_LICENSES.txt for attribution.
