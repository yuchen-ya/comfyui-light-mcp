# User guide

[简体中文](usage.zh-CN.md) · [Overview](../README.md)

## Install a local candidate package

In a source checkout, `npm ci` installs the locked dependencies and `npm pack` builds a local tarball. In a separate new directory:

```powershell
npm init -y
npm install --omit=dev C:/handoff/comfyui-light-mcp-0.3.0-rc.2.tgz
Copy-Item node_modules/comfyui-light-mcp/config.env.example config.env
Copy-Item -Recurse node_modules/comfyui-light-mcp/examples workflows
```

Replace `C:/handoff` with the tarball location. Set `WORKFLOWS_DIR=./workflows` in `config.env`, then launch:

```powershell
node --env-file=config.env node_modules/comfyui-light-mcp/dist/index.js
```

This waits for an MCP client over stdio. Configure your client as shown in the README, pointing its `args` at the installed `dist/index.js`. Use absolute workflow, data and output directories. `better-sqlite3` needs a native addon matching Node and the machine architecture. Allow installation scripts; when no prebuilt binary is available, Python and Visual Studio C++ Build Tools are needed. Do not copy another machine's `node_modules`.

## Configuration

Node's `--env-file` loads the named file; there is no automatic `.env` discovery. Explicit environment variables take precedence. Paths resolve against the process working directory, not the env-file location. Keep personal settings outside version control.

| Variable | Default | Meaning |
|---|---|---|
| `COMFYUI_URL` | `http://127.0.0.1:8188` | HTTP(S) endpoint; optional proxy path prefix; HTTP and WS must both work |
| `WORKFLOWS_DIR` | `./workflows` | Recursively scanned for `*.manifest.json` |
| `DATA_DIR` | `./data` | SQLite state directory, created on startup |
| `OUTPUT_DIR` | `./output` | Downloaded files and JSONL indexes |
| `AUTO_SAVE_OUTPUTS` | `true` | Download on completion; false defers to result queries |
| `MAX_IN_FLIGHT` | `1` | 1–64 submitted/uncertain/queued/executing jobs |
| `MAX_QUEUED_JOBS` | `1` | 1–64 queued jobs, no greater than MAX_IN_FLIGHT |
| `JOB_TIMEOUT_MS` | `600000` | Wall-clock deadline, 10000–86400000 ms |

Booleans accept `true/false/1/0`. The sample configuration uses `./examples` for the model-free check. URL credentials, query parameters and fragments are rejected; backend authentication is unsupported. Use a trusted endpoint. Workflow files reload automatically; configuration changes require restarting the MCP process.

## Workflows and parameter manifests

Export from ComfyUI in **API format**: an object keyed by node IDs, each containing `class_type` and `inputs`. Visual editor JSON with `nodes`/`links` is unsuitable; a `{ "prompt": { ... } }` wrapper is accepted. Review graphs and custom nodes before use. Put the API JSON and its manifest in the same directory under `WORKFLOWS_DIR`.

The bundled `solid-color` example uses built-in `EmptyImage` → `SaveImage` and needs no model. A minimal manifest:

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

Names start with a letter and use letters, digits, `_` or `-`, up to 64 characters. `workflowFile` is a filename in the same directory. At least one parameter is required; each targets an existing scalar input, never a link. Types are `string`, `number`, `integer`, `boolean`, `enum`; enums need a nonempty string array. Numeric bounds and `step` are checked, with step relative to `min` or zero. `required: true` and `default` are mutually exclusive. With neither, omission keeps the graph's input. Integer seeds may use `special: "seed"` and `default: -1`; actual resolved seeds are persisted for execution.

File edits are detected on list/run/dry-run calls and scheduler refreshes. Invalid or deleted files block new execution. Pending jobs pause on fingerprint mismatch; restore the original file pair to resume them, or use a new workflow name and batch for intentional edits. Already submitted jobs continue with their submitted graph.

## Preflight and execution

These JSON objects are MCP tool arguments, not terminal commands. `list_workflows` lists summaries; `{"workflow":"solid-color"}` requests parameter details and load status. Preflight with `run_workflow`:

```json
{"workflow":"solid-color","dry_run":true,"params":{"color":255}}
```

Dry-run checks parameters, graph structure and available backend node/model schemas. It creates no Batch/Job/Attempt and submits no generation. `valid=true` means no blocking error was found; inspect `checks`, warnings and `validation_sources` too. `unknown` and stale/unavailable schemas do not prove the backend can execute. Custom dynamic nodes may need runtime validation. A dry-run does not reserve an idempotency key or freeze files for a later call.

Single execution:

```json
{"workflow":"solid-color","params":{"color":255},"idempotency_key":"single-demo-1"}
```

Batch execution, at most 200 runs:

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

`params` and `runs` are mutually exclusive; omission uses one run with defaults. Invalid batch items are recorded independently; invalid single parameters reject the call. Both forms accept `max_attempts` (1–5 total attempts, default 1) and `continue_on_error` (default true; false abandons remaining unsubmitted work after terminal failure). Retries require confirmed remote failure. Unknown submissions are never automatically duplicated. The same key and identical content reuse the batch; different content, retry options or workflow fingerprints produce `IDEMPOTENCY_CONFLICT`. Inspect the old batch before creating a replacement request.

## Poll and collect results

Call `get_batch` with `{"batch_id":"<returned id>","limit":20,"offset":0}`. The limit is at most 100; `next_offset` continues pagination and optional `status` filters jobs. Counts keep unknown and paused separate from failures. Poll every few seconds with a client deadline.

Use `get_result` with `{"batch_id":"<id>","mode":"index","download":true}` to write `OUTPUT_DIR/<batch_id>/results.jsonl`. It contains one row per original job, ordered by index, with labels, status, actual seed when available, concise errors and all output references. Each file has availability, byte count and a usable absolute local path when present. The MCP response returns only a summary and `index_path`; the client needs its own permission to read local files. On a remote host the paths belong to that host.

`complete` means execution is terminal, not that every file exists; also check `unavailable_outputs`. Repeating the call retries missing downloads without generating again. `download=false` only indexes available files. The index is the latest snapshot. For one job use `{"batch_id":"<id>","index":0,"download":true}` for resolved parameters and output details.

## Inputs, recovery and backups

Upload source media through ComfyUI or copy it into ComfyUI's input directory. Expose loader filenames as manifest string parameters, such as `"image":"source.png"`. These names resolve on the ComfyUI host. Keep inputs stable while work is pending. This server has no upload, workflow editing, model management or cancellation tool.

State lives in `DATA_DIR/comfyui-light.db` using WAL. Use one MCP process per database on local writable storage. Schema v1–v4 migrates transactionally to v5; newer unknown schemas are rejected. Old pending jobs lacking fingerprints pause. Unknown previous attempts reconcile with backend queue/history before any retry. Do not manually edit database statuses or remove write guards.

Before upgrading, stop the MCP process and wait for exit, then copy the entire DATA_DIR including any WAL/SHM files while no process writes it. For live backups use SQLite's online backup API. Keep OUTPUT_DIR, workflow/manifest pairs and ComfyUI inputs separately. Restore into an independent directory using a matching backup and version; do not run an old binary against the upgraded database. Client disconnect/EOF or SIGINT/SIGTERM closes local scheduling and SQLite; it does not cancel remote generation. Restart reconciles saved jobs.

| Symptom | Action |
|---|---|
| Native addon missing / ABI mismatch | Reinstall with the matching Node architecture and installation scripts enabled |
| No workflow / invalid load | Check API format, manifest filename and target inputs; inspect list_workflows load errors |
| COMFY_UNREACHABLE / pending jobs | Check endpoint and both HTTP and WebSocket connectivity |
| submission_unknown / TIMEOUT_UNCONFIRMED | Keep database and backend history; wait for reconciliation and inspect remote work before resubmitting |
| paused / WORKFLOW_VERSION_MISMATCH | Restore the original workflow pair, or start intentional new work under a new workflow name |
| complete with missing files | Inspect availability and unavailable_outputs; restore backend files and retry collection |
| JSON parsing failure at client | Launch node directly; stdout is reserved for MCP |

Recovery depends on backend history and queue evidence; clearing them can leave unknown work unresolved. Custom output formats may not expose downloadable references. Identical seeds do not guarantee reproducibility across nodes, models, versions or hardware. Disk retention and cleanup are manual. Only Windows 11 x64 is currently supported; other platforms and Node major versions have not been validated.
