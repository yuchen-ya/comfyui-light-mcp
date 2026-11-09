import http from 'node:http';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

// Transparent loopback relay: observe the agent's requests, never create or retry one.
const [listenArg, targetArg, directory] = process.argv.slice(2);
const listenPort = Number(listenArg);
const targetPort = Number(targetArg);
if (!directory || ![listenPort, targetPort].every(port => Number.isInteger(port) && port > 0 && port < 65536) || listenPort === targetPort) {
  throw new Error('Usage: node prompt-observer.mjs LISTEN_PORT TARGET_PORT LOCAL_EVIDENCE_DIR');
}
await mkdir(directory, { recursive: true });
const logFile = path.resolve(directory, 'observer.jsonl');
let writes = Promise.resolve();
const record = event => {
  writes = writes.then(() => appendFile(logFile, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'));
  writes.catch(error => { process.stderr.write(`Observer log failed: ${error.message}\n`); process.exit(1); });
};
let sequence = 0;
const server = http.createServer((request, response) => {
  const requestId = ++sequence;
  const promptPost = request.method === 'POST' && new URL(request.url, 'http://localhost').pathname === '/prompt';
  const requestChunks = [];
  const responseChunks = [];
  const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, method: request.method,
    path: request.url, headers: { ...request.headers, host: `127.0.0.1:${targetPort}` } }, incoming => {
    response.writeHead(incoming.statusCode, incoming.headers);
    if (promptPost) {
      incoming.on('data', chunk => responseChunks.push(chunk));
      incoming.on('end', () => record({ kind: 'prompt_response', request_id: requestId,
        status: incoming.statusCode, body: Buffer.concat(responseChunks).toString('utf8') }));
      incoming.on('aborted', () => record({ kind: 'prompt_response_aborted', request_id: requestId }));
    }
    incoming.on('aborted', () => response.destroy());
    incoming.pipe(response);
  });
  upstream.on('error', error => {
    record({ kind: 'upstream_error', request_id: requestId, method: request.method, url: request.url, error: error.message });
    if (!response.headersSent) { response.writeHead(502); response.end(); }
    else response.destroy();
  });
  if (promptPost) {
    request.on('data', chunk => requestChunks.push(chunk));
    request.on('end', () => record({ kind: 'prompt_request', request_id: requestId,
      body: Buffer.concat(requestChunks).toString('utf8') }));
    request.on('aborted', () => record({ kind: 'prompt_request_aborted', request_id: requestId }));
  }
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
});
const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  sockets.handleUpgrade(request, socket, head, downstream => {
    const connectionId = ++sequence;
    const upstream = new WebSocket(`ws://127.0.0.1:${targetPort}${request.url}`);
    const pending = [];
    record({ kind: 'ws_connect', connection_id: connectionId });
    upstream.on('open', () => {
      for (const [data, binary] of pending) upstream.send(data, { binary });
      pending.length = 0;
    });
    downstream.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push([data, binary]);
    });
    upstream.on('message', (data, binary) => {
      if (!binary) {
        let event;
        try { event = JSON.parse(data.toString()); } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        if (event && ['execution_start', 'execution_success', 'execution_error', 'execution_interrupted', 'execution_cached'].includes(event.type)) {
          record({ kind: 'ws_event', connection_id: connectionId, event });
        }
      }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
    });
    upstream.on('error', error => {
      record({ kind: 'ws_error', connection_id: connectionId, error: error.message });
      downstream.close();
    });
    downstream.on('error', error => record({ kind: 'ws_error', connection_id: connectionId, error: error.message }));
    upstream.on('close', () => { record({ kind: 'ws_close', connection_id: connectionId }); downstream.close(); });
    downstream.on('close', () => upstream.close());
  });
});
server.listen(listenPort, '127.0.0.1', () => {
  record({ kind: 'observer_start', listen_port: listenPort, target_port: targetPort });
  process.stdout.write('Loopback observer ready\n');
});
server.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
