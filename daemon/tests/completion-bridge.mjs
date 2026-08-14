import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';

const daemonDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.resolve(daemonDir, '..');
const token = '0123456789abcdef0123456789abcdef0123456789abcdef';
const daemonExecutable = process.env.DAEMON_EXECUTABLE
  ? path.resolve(workspace, process.env.DAEMON_EXECUTABLE)
  : process.execPath;
const daemonArguments = process.env.DAEMON_EXECUTABLE ? [] : ['dist/server.js'];

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function waitForOutput(child, pattern, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for daemon output: ${output}`)), timeoutMs);
    const onData = chunk => {
      output += chunk.toString();
      if (!pattern.test(output)) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolve(output);
    };
    child.stdout.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Daemon exited early with ${code}: ${output}`));
    });
  });
}

function waitForSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForMessage(socket, type, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function eventLogUntilFinished(baseUrl, controller) {
  const response = await fetch(`${baseUrl}/v1/events?include_content=1`, {
    headers: {authorization: `Bearer ${token}`},
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (!output.includes('event: completion.finished')) {
    const {done, value} = await reader.read();
    if (done) break;
    output += decoder.decode(value, {stream: true});
  }
  return output;
}

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(daemonExecutable, daemonArguments, {
  cwd: daemonDir,
  env: {
    ...process.env,
    PORT: String(port),
    DEEPSEEK_LOCAL_TOKEN: token,
    DEEPSEEK_WORKSPACE: workspace,
    COMPLETION_TIMEOUT_MS: '10000'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let socket;

try {
  await waitForOutput(child, /Local AI Agent ready/);
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws/extension`, ['local-ai-agent', `token.${token}`]);
  await waitForSocketOpen(socket);
  socket.send(JSON.stringify({
    type: 'bridge.register',
    client_id: 'integration-test-tab',
    provider: 'deepseek',
    url: 'https://chat.deepseek.com/a/chat/s/test'
  }));
  await waitForMessage(socket, 'bridge.ready');

  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'completion.request') return;
    socket.send(JSON.stringify({type: 'completion.accepted', request_id: message.request_id}));
    if (message.messages.some(item => item.content === 'Hold this request')) return;
    socket.send(JSON.stringify({type: 'completion.delta', request_id: message.request_id, sequence: 0, delta: 'Hello'}));
    socket.send(JSON.stringify({type: 'completion.delta', request_id: message.request_id, sequence: 1, delta: ' world'}));
    socket.send(JSON.stringify({
      type: 'completion.completed',
      request_id: message.request_id,
      content: 'Hello world',
      finish_reason: 'stop'
    }));
  });

  const models = await fetch(`${baseUrl}/v1/models`, {headers: {authorization: `Bearer ${token}`}}).then(value => value.json());
  assert.deepEqual(models.data.map(model => model.id), ['auto', 'deepseek-web']);

  const eventController = new AbortController();
  const eventLogPromise = eventLogUntilFinished(baseUrl, eventController);
  const nonStreaming = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
    body: JSON.stringify({model: 'deepseek-web', messages: [{role: 'user', content: 'Say hello'}]})
  });
  assert.equal(nonStreaming.status, 200);
  const completion = await nonStreaming.json();
  assert.equal(completion.object, 'chat.completion');
  assert.equal(completion.choices[0].message.content, 'Hello world');
  const eventLog = await eventLogPromise;
  eventController.abort();
  assert.match(eventLog, /event: completion\.delta/);
  assert.match(eventLog, /"delta":"Hello"/);

  const streaming = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
    body: JSON.stringify({model: 'deepseek-web', stream: true, messages: [{role: 'user', content: 'Say hello'}]})
  });
  assert.equal(streaming.status, 200);
  assert.match(streaming.headers.get('content-type') || '', /text\/event-stream/);
  const streamBody = await streaming.text();
  assert.match(streamBody, /"object":"chat\.completion\.chunk"/);
  assert.match(streamBody, /"content":"Hello"/);
  assert.match(streamBody, /"content":" world"/);
  assert.match(streamBody, /data: \[DONE\]/);

  if (!process.env.DAEMON_EXECUTABLE) {
    const cancellation = waitForMessage(socket, 'completion.cancel');
    let cancellationResolved = false;
    void cancellation.then(() => { cancellationResolved = true; });
    const heldBody = JSON.stringify({
      model: 'deepseek-web',
      stream: true,
      messages: [{role: 'user', content: 'Hold this request'}]
    });
    const heldConnection = await new Promise((resolve, reject) => {
      const request = http.request(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(heldBody),
          authorization: `Bearer ${token}`
        }
      }, response => {
        assert.equal(response.statusCode, 200);
        resolve({request, response});
      });
      request.once('error', error => {
        if (error.code === 'ECONNRESET') resolve({request, response: {destroy() {}}});
        else reject(error);
      });
      request.end(heldBody);
    });
    await new Promise(resolve => setTimeout(resolve, 1_000));
    assert.equal(cancellationResolved, false, 'Held stream was cancelled before its client disconnected');
    heldConnection.response.destroy();
    heldConnection.request.destroy();
    await cancellation;
  }

  const unknownModel = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
    body: JSON.stringify({model: 'unknown-provider', messages: [{role: 'user', content: 'No'}]})
  });
  assert.equal(unknownModel.status, 400);

  const unavailable = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: 'Bearer wrong'},
    body: JSON.stringify({model: 'deepseek-web', messages: [{role: 'user', content: 'No'}]})
  });
  assert.equal(unavailable.status, 401);

  console.log('OpenAI completion bridge integration: PASS');
} finally {
  socket?.close();
  if (child.exitCode == null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2_000))
    ]);
  }
}
