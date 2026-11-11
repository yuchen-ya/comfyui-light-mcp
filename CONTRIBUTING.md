# Development

Use Node.js 22.12+ on Windows x64 and the existing lockfile. In a new checkout run `npm ci`; keep credentials, personal workflows, databases and generated output outside version control.

```powershell
npm run lint
npm run typecheck
npm test -- --fileParallelism=false
npm run build
npm pack --dry-run
```

Default tests use mocks, temporary SQLite databases and local WebSocket servers. Model/GPU integration tests require explicit `RUN_REAL_COMFYUI_TESTS=1` and `COMFYUI_URL` pointing to an isolated backend; they submit jobs, can interrupt them, and need the models referenced by `workflows/examples`. Never use a shared or production backend. `npm run smoke` requires both variables too. Tests that cannot reach the backend skip; skipped cases are not evidence of successful generation.

For a model-free installed-package check, start an isolated ComfyUI with CPU mode, empty model directories, custom/partner nodes disabled and separate input/output/user/temp directories. Then run:

```powershell
node scripts/verify-install.mjs <installed-package-directory> <new-run-directory> <isolated-comfy-url>
```

The script refuses an existing run directory and verifies stdio MCP, native SQLite, generation, downloads, result indexes and restart persistence. Run it against the exact final tarball, installed into a separate consumer directory. `npm pack` invokes the build automatically.

Review every changed file and the actual tarball for privacy, secrets, unexpected files and license notices. Keep engineering acceptance records separate from README and user-facing release notes. Publication needs the project owner's explicit approval.
