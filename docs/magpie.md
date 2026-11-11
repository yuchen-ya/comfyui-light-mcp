# Install with Magpie

[简体中文](magpie.zh-CN.md) · [User guide](usage.md) · [Overview](../README.md)

You can install a supplied tarball directly. The npm command requires this exact version to be available on npm; Magpie discovery also requires its Registry entry. Use the local tarball route if the package or entry is not available to you.

## Before you start

Use Windows 11 x64 and Node.js 22.12+. Install and start ComfyUI separately, with the models and custom nodes your workflows require. Allow npm installation scripts for the native SQLite addon.

Prepare a directory containing workflow API JSON files and their matching `*.manifest.json` files. Copy both bundled `solid-color` files there for a model-free first run. This server does not install ComfyUI, download models or create your workflow library.

## Add the published entry

After publication, search Magpie for `comfyui-light-mcp`. Check the repository is [yuchen-ya/comfyui-light-mcp](https://github.com/yuchen-ya/comfyui-light-mcp) and the Registry name is `io.github.yuchen-ya/comfyui-light-mcp`, then select the npm/stdio entry.

Fill in these four values yourself:

| Setting | Value |
|---|---|
| `COMFYUI_URL` | Your running, trusted ComfyUI HTTP(S) endpoint, often `http://127.0.0.1:8188`. Both HTTP and WebSocket access must work. Credentials, query strings and fragments are unsupported. |
| `WORKFLOWS_DIR` | Absolute existing directory containing reviewed workflow JSON/manifest pairs. |
| `DATA_DIR` | Absolute writable directory for SQLite state. Use a separate directory for each concurrent MCP process. |
| `OUTPUT_DIR` | Absolute writable directory for downloaded outputs and JSONL indexes. |

Enter paths containing spaces as plain values, without additional quote characters. These directories belong to the computer running the MCP server. Magpie does not choose the address, copy your workflows or prepare models for you.

Keep the exact package version in the launch command. For this prerelease, after npm publication:

```text
npx -y --package comfyui-light-mcp@0.3.0-rc.2 comfyui-light-mcp
```

Check the actual command in your client instead of assuming `latest` selects this prerelease. Finding the entry does not mean it can connect to your ComfyUI; the four settings still need to match your installation.

## Install from a local tarball

Install the supplied tarball in a separate directory as shown in the [user guide](usage.md#install-a-local-candidate-package). No source checkout is needed. For manual configuration, use the command/args/env portion below in your client's stdio entry:

```json
{
  "command": "node",
  "args": ["C:/mcp/install/node_modules/comfyui-light-mcp/dist/index.js"],
  "env": {
    "COMFYUI_URL": "http://127.0.0.1:8188",
    "WORKFLOWS_DIR": "C:/mcp/my workflows",
    "DATA_DIR": "C:/mcp/my data",
    "OUTPUT_DIR": "C:/mcp/my output"
  }
}
```

These are placeholder paths. Replace them and the ComfyUI address with your own values. Windows installations also expose `node_modules/.bin/comfyui-light-mcp.cmd`.

The process reads its environment; it does not automatically find a `.env` file. To use an env file, explicitly pass `--env-file=<absolute file>` to Node. Relative paths resolve against the process working directory, not the package or env-file directory, so use absolute paths in a client configuration.

## Optional settings and first run

When omitted, the application uses `AUTO_SAVE_OUTPUTS=true`, `MAX_IN_FLIGHT=1`, `MAX_QUEUED_JOBS=1` and `JOB_TIMEOUT_MS=600000`. These are application defaults, not a promise that Magpie fills optional fields. Override them in the server's environment through your client's supported settings. The queue limit must not exceed the in-flight limit. See [configuration](usage.md#configuration).

Connect the client, call `list_workflows`, then call `run_workflow` with:

```json
{"workflow":"solid-color","dry_run":true,"params":{"color":255}}
```

Inspect errors, warnings and any `unknown` checks before generating. Omit `dry_run` to run the example. A terminal launch waits for JSON-RPC input; it does not open a web page. Keep stdout for MCP and read diagnostics from stderr.

An offline installation needs the dependencies and native addon already cached. A tarball alone cannot supply missing dependencies. This server has no backend authentication configuration and should use a trusted ComfyUI endpoint.
