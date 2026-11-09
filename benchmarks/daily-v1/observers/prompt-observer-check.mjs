import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { setTimeout } from 'node:timers';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { WebSocket, WebSocketServer } from 'ws';

const observer = join(dirname(fileURLToPath(import.meta.url)), 'prompt-observer.mjs');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const request = (port, path, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), aborted: false }));
    res.on('aborted', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), aborted: true }));
    res.on('error', () => {});
  });
  req.on('error', reject);
  req.end(body);
});

test('relay forwards one submission and websocket traffic; records disconnects and upstream errors', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-observer-'));
  const prompt = Buffer.from('{"prompt":{"id":1},"extra":"unchanged"}');
  const reply = Buffer.from('{"prompt_id":"mock-id","unchanged":true}');
  const seen = [];
  const target = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url, body: Buffer.concat(chunks) });
      if (req.url === '/prompt?abort') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"partial":');
        setTimeout(() => res.destroy(), 30);
      } else {
        res.writeHead(201, { 'Content-Type': 'application/json', 'X-Mock': 'preserved' });
        res.end(reply);
      }
    });
  });
  const wsServer = new WebSocketServer({ server: target });
  const startEvent = JSON.stringify({ type: 'execution_start', data: { prompt_id: 'mock-id' } });
  let wsPath;
  wsServer.on('connection', (ws, req) => {
    wsPath = req.url;
    ws.send(startEvent);
    ws.send('plain text event');
    ws.on('message', (data, binary) => ws.send(data, { binary }));
  });
  const targetPort = await listen(target);
  const reservation = net.createServer();
  const observerPort = await listen(reservation);
  await close(reservation);
  const child = spawn(process.execPath, [observer, String(observerPort), String(targetPort), dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    wsServer.close();
    if (target.listening) await close(target);
    rmSync(dir, { recursive: true, force: true });
  });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error(`Observer exited: ${stderr}`); })]);
  const result = await request(observerPort, '/prompt?x=1', prompt);
  assert.equal(result.status, 201);
  assert.equal(result.headers['x-mock'], 'preserved');
  assert.deepEqual(result.body, reply);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/prompt?x=1');
  assert.deepEqual(seen[0].body, prompt);

  const client = new WebSocket(`ws://127.0.0.1:${observerPort}/ws?clientId=mock-client`);
  const messages = [];
  client.on('message', data => messages.push(data.toString()));
  await once(client, 'open');
  client.send('client message');
  for (let i = 0; i < 100 && messages.length < 3; i++) await delay(10);
  assert.deepEqual(messages, [startEvent, 'plain text event', 'client message']);
  assert.equal(wsPath, '/ws?clientId=mock-client');
  client.close();
  await once(client, 'close');

  const interrupted = await request(observerPort, '/prompt?abort', prompt);
  assert.equal(interrupted.aborted, true);
  assert.equal(seen.length, 2);
  await close(target);
  const failed = await request(observerPort, '/prompt', prompt);
  assert.equal(failed.status, 502);
  assert.equal(seen.length, 2);
  let events = [];
  for (let i = 0; i < 100; i++) {
    events = readFileSync(join(dir, 'observer.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    if (events.some(e => e.kind === 'upstream_error') && events.some(e => e.kind === 'prompt_response_aborted')) break;
    await delay(10);
  }
  assert.equal(events.filter(e => e.kind === 'prompt_request').length, 3);
  assert.equal(events.filter(e => e.kind === 'prompt_response').length, 1);
  assert.equal(events.find(e => e.kind === 'prompt_response').body, reply.toString());
  assert.equal(events.find(e => e.kind === 'ws_event').event.data.prompt_id, 'mock-id');
  assert.ok(events.some(e => e.kind === 'prompt_response_aborted'));
  assert.ok(events.some(e => e.kind === 'upstream_error'));
});
