# ComfyUI Light MCP

[简体中文](README.zh-CN.md) · [User guide](docs/usage.md) · [Magpie setup](docs/magpie.md) · MIT · Prerelease 0.3.0-rc.2

A local stdio MCP server that lets an AI client run ComfyUI workflows you have already reviewed.

## Product direction

Workflow-first, Batch-native, Context-light.

- **Workflow-first:** export a workflow from ComfyUI in API format once, and write a manifest that whitelists the parameters a client may change. Each call sends only those parameters, not the whole graph.
- **Batch-native:** one call submits up to 200 labeled runs, with idempotency keys, SQLite persistence and conservative recovery after interruption.
- **Context-light:** only four tools, `list_workflows`, `run_workflow`, `get_batch`, `get_result`. Tools return summaries and paginated status; batch results can be written to a local JSONL index without returning image data into the conversation.

Requires Windows 11 x64 and Node.js 22.12+. ComfyUI must be installed and running separately. This server does not install ComfyUI, custom nodes or models.

## Differences from the official Comfy MCP

Comfy Org's official [Comfy MCP](https://github.com/Comfy-Org/comfy-mcp) aims at driving ComfyUI from AI agents in general: it is Python-based (via comfy-cli), exposes around 40 tools, and can search the official template gallery, fetch and modify workflow graphs, validate them against the local install, and more; a hosted Comfy Cloud variant also exists.

What this project lacks next to that is deliberate:

- **No workflow editing through MCP.** A workflow is a plain JSON file in `WORKFLOWS_DIR`, paired with its manifest. Agents can use their file tools to maintain the pair. Changes are detected on the next list, run or dry-run call and by the scheduler. Invalid edits block new execution instead of falling back to an older graph; pending jobs pause if their saved workflow fingerprint no longer matches.
- **A minimal MCP surface.** Only what must pass through the server goes through MCP: submitting whitelisted parameters, scheduling batches, tracking state and collecting results. Template galleries, uploads and model management are out of scope; the workflow file remains an ordinary file the agent can edit.

| | Official Comfy MCP | This project |
|---|---|---|
| Scope | General agent control of local (or cloud) ComfyUI | Running pre-approved local workflows only |
| Workflow source | Official template gallery, fetched/composed/edited by the agent | Locally exported API JSON + a manifest parameter whitelist |
| Tools | ~40 (search, compose, edit, validate…) | 4 (list / run / poll / fetch results) |
| Per call | The agent can send and modify full workflow graphs | Only whitelisted parameters are sent |
| Stack / license | Python + comfy-cli, AGPL-3.0 or commercial | Node.js 22, MIT |
| Platform | Cross-platform | Windows 11 x64 only |

The two overlap but are not substitutes: use the official server when the agent should compose and modify workflows through MCP tool calls; this project is a narrower option when workflows live as plain files — edited with the agent's own file tools — and MCP is used only to run them, including in batches.

## Installation for AI agents

Follow these steps to install this server for your user. Target environment: Windows 11 x64, Node.js >= 22.12, ComfyUI already running (default `http://127.0.0.1:8188`).

1. Clone or unpack the source, then in the checkout run:

   ```powershell
   npm ci          # do not use --ignore-scripts; better-sqlite3 loads a native addon
   npm run build
   ```

2. Add the server to the user's MCP client settings, replacing placeholder paths with real absolute paths and adjusting environment variables as needed:

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

3. Place workflow API JSON files and their `*.manifest.json` into `WORKFLOWS_DIR`. For a first check, copy both files from `examples/` to that directory. Subsequent edits reload automatically; changing environment variables requires a server restart.
4. Verify with `list_workflows`, then call `run_workflow` with `{"workflow":"solid-color","dry_run":true,"params":{"color":255}}`. Check errors, warnings and any `unknown` checks before running. Omit `dry_run` to generate the model-free example.

For manual configuration, launch `node .../dist/index.js` directly. The [Magpie guide](docs/magpie.md) covers package-based startup. Stdout is reserved for the MCP protocol; a terminal launch simply waits for JSON-RPC input. For all configuration variables see `config.env.example`; for a minimal manifest see `examples/`.

See the [user guide](docs/usage.md) for local tarball installation, configuration, batch submission, result indexes, backups and recovery. Run one MCP process per database against a trusted local ComfyUI endpoint. This server has no backend authentication configuration. It does not guarantee token or cost savings. For development commands see [CONTRIBUTING.md](CONTRIBUTING.md).
