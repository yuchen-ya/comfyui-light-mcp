import http from 'node:http';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The same generic code-mode transport for both arms. No workflow operations,
// parameter mapping, polling, retries, output processing, or experiment logic.
const [launchPath, portText] = process.argv.slice(2);
const port = Number(portText);
if (!launchPath || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Usage: node mcp-bridge.mjs PRIVATE_LAUNCH_JSON LOOPBACK_PORT');
const launch = JSON.parse(await readFile(launchPath, 'utf8'));
const directory = path.dirname(path.resolve(launchPath));
await mkdir(directory, { recursive: true });
const logPath = path.join(directory, 'raw-mcp-calls.jsonl');
let logTail = Promise.resolve();
const record = entry => {
  logTail = logTail.then(() => appendFile(logPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'));
  return logTail;
};
const env = { ...process.env };
for (const key of Object.keys(env)) if (Object.keys(launch.env).some(name => name.toUpperCase() === key.toUpperCase())) delete env[key];
Object.assign(env, launch.env);
const client = new Client({ name: 'daily-fast-code-mode', version: '1.0.0' });
const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env, stderr: 'pipe' });
transport.stderr?.on('data', data => process.stderr.write(data));
await record({ kind: 'request', id: 1, method: 'initialize' });
await client.connect(transport);
const contract = { server: client.getServerVersion(), instructions: client.getInstructions() };
await record({ kind: 'response', id: 1, method: 'initialize', result: contract });
await record({ kind: 'request', id: 2, method: 'tools/list', params: {} });
const tools = await client.listTools();
await record({ kind: 'response', id: 2, method: 'tools/list', result: tools });
let sequence = 2;
const response = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/contract') return response(res, 200, contract);
  if (req.method === 'GET' && url.pathname === '/tools') {
    const names = url.searchParams.get('names')?.split(',');
    if (url.searchParams.get('brief') === '1') return response(res, 200, { tools: tools.tools.map(tool => ({ name: tool.name, description: tool.description?.split('\n')[0] })) });
    return response(res, 200, names ? { tools: tools.tools.filter(tool => names.includes(tool.name)) } : tools);
  }
  if (req.method !== 'POST' || url.pathname !== '/call') return response(res, 404, { error: 'Unknown bridge route' });
  let payload;
  try {
    const parts = [];
    for await (const part of req) parts.push(part);
    payload = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return response(res, 400, { error: 'Expected JSON' });
  }
  if (typeof payload?.name !== 'string' || !tools.tools.some(tool => tool.name === payload.name)) return response(res, 400, { error: 'Unknown selected-server tool' });
  const id = ++sequence;
  await record({ kind: 'request', id, method: 'tools/call', params: payload });
  try {
    const result = await client.callTool(payload, undefined, { timeout: 3_600_000 });
    await record({ kind: 'response', id, method: 'tools/call', result });
    response(res, 200, result);
  } catch (error) {
    await record({ kind: 'response_error', id, method: 'tools/call', error: error.message });
    response(res, 502, { error: error.message, note: 'No retry was made; reconcile any unknown submission.' });
  }
});
server.on('error', error => { process.stderr.write(`BRIDGE_FAILURE: ${error.message}\n`); process.exit(1); });
server.listen(port, '127.0.0.1', () => process.stdout.write('Selected-server bridge ready\n'));
