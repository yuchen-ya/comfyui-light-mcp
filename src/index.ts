#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { openDb } from "./core/storage/db.js";
import { createComfyClient } from "./core/client/index.js";
import { Engine } from "./core/engine.js";
import { createMcpServer } from "./mcp/server.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * 入口：config → db → registry 扫描 → ComfyUI 客户端（尽力连接，失败不退出）→ 恢复 → stdio MCP。
 */

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(path.dirname(path.join(config.dataDir, "x")), { recursive: true });
  const db = openDb(path.join(config.dataDir, "comfyui-light.db"));

  const client = createComfyClient({ comfyUiUrl: config.comfyUiUrl });
  const engine = new Engine(config, client, db);

  const report = await engine.loadWorkflowsAsync();
  for (const e of report.errors) {
    console.error(`[workflow] 加载失败 ${e.file}: ${e.message}`);
  }

  // ComfyUI 连接：尽力而为（不可达时仍启动 MCP，工具调用会返回明确错误）
  let connected = false;
  try {
    await client.start();
    connected = true;
  } catch (e) {
    console.error(`[comfyui] 初始连接失败（稍后可重试工具调用）: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Engine's scheduler reconciles every connection epoch before allowing submissions,
  // including a delayed first connection after client.start() times out.
  engine.start();

  const server = createMcpServer(engine);
  await server.connect(new StdioServerTransport());
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
      await engine.stop();
    } finally {
      client.stop();
      db.close();
    }
  };
  const onShutdown = (): void => {
    void shutdown().catch((error: unknown) => {
      console.error("关闭失败:", error);
      process.exitCode = 1;
    });
  };
  process.stdin.once("end", onShutdown);
  process.once("SIGINT", onShutdown);
  process.once("SIGTERM", onShutdown);
  console.error(`[mcp] stdio server ready (workflows=${report.loaded.length}, comfyui=${connected ? "connected" : "unreachable"})`);
}

void main().catch((e) => {
  console.error("启动失败:", e);
  process.exit(1);
});
