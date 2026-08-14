import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class TestCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

class TestXmlHttpRequest {
  open() {}
  send() {}
  addEventListener() {}
}

function bridgeContext(href, nativeFetch) {
  const events = [];
  const context = {
    URL,
    Request,
    Response,
    ReadableStream,
    TextDecoder,
    TextEncoder,
    CustomEvent: TestCustomEvent,
    XMLHttpRequest: TestXmlHttpRequest,
    location: {href},
    document: {
      dispatchEvent(event) {
        events.push({type: event.type, detail: event.detail});
      }
    },
    fetch: nativeFetch,
    console,
    setTimeout,
    clearTimeout
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  return {context, events};
}

function loadBridge(context, filename) {
  const code = fs.readFileSync(new URL(`../dist/${filename}`, import.meta.url), 'utf8');
  vm.runInContext(code, context);
}

const encoder = new TextEncoder();
const deepSeekData = value => `data: ${JSON.stringify(value)}\n\n`;
let deepSeekController;
const deepSeekBody = new ReadableStream({start(controller) { deepSeekController = controller; }});
const deepSeek = bridgeContext('https://chat.deepseek.com/a/chat/s/test', async () => {
  const response = new Response(deepSeekBody, {status: 200});
  Object.defineProperty(response, 'url', {value: 'https://chat.deepseek.com/api/v0/chat/completion'});
  return response;
});
loadBridge(deepSeek.context, 'deepseek-stream.js');
await deepSeek.context.fetch('https://chat.deepseek.com/api/v0/chat/completion');
deepSeekController.enqueue(encoder.encode(deepSeekData({
  v: {response: {status: 'WIP', fragments: [{type: 'RESPONSE', content: 'Hello'}]}}
})));
deepSeekController.enqueue(encoder.encode(deepSeekData({
  p: 'response/fragments/-1/content', o: 'APPEND', v: ' world'
})));
await new Promise(resolve => setTimeout(resolve, 25));
assert.deepEqual(
  deepSeek.events.filter(event => event.type === 'local-ai-agent:provider-stream-delta').map(event => event.detail),
  ['Hello', ' world']
);
assert.equal(deepSeek.events.some(event => event.type === 'local-ai-agent:deepseek-answer'), false);
deepSeekController.enqueue(encoder.encode(deepSeekData({p: 'response/status', o: 'SET', v: 'FINISHED'})));
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(
  deepSeek.events.find(event => event.type === 'local-ai-agent:deepseek-answer')?.detail,
  'Hello world'
);
assert.deepEqual(
  deepSeek.events.filter(event => event.type === 'local-ai-agent:provider-stream-state').map(event => event.detail),
  ['started', 'finished']
);

const zaiBody = [
  {type: 'chat:completion', data: {phase: 'answer', delta_content: 'Hello'}},
  {type: 'chat:completion', data: {phase: 'answer', delta_content: ' world'}}
].map(value => `data: ${JSON.stringify(value)}\n\n`).join('');
const zai = bridgeContext('https://chat.z.ai/c/test', async () => {
  const response = new Response(zaiBody, {status: 200});
  Object.defineProperty(response, 'url', {value: 'https://chat.z.ai/api/v2/chat/completions'});
  return response;
});
loadBridge(zai.context, 'zai-stream.js');
await zai.context.fetch('https://chat.z.ai/api/v2/chat/completions');
await new Promise(resolve => setTimeout(resolve, 25));
assert.deepEqual(
  zai.events.filter(event => event.type === 'local-ai-agent:provider-stream-delta').map(event => event.detail),
  ['Hello', ' world']
);
assert.equal(zai.events.find(event => event.type === 'local-ai-agent:zai-answer')?.detail, 'Hello world');
assert.deepEqual(
  zai.events.filter(event => event.type === 'local-ai-agent:provider-stream-state').map(event => event.detail),
  ['started', 'finished']
);

console.log('DeepSeek and Z.ai stream regressions: PASS');
