import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformWithOxc} from 'vite';

const sourcePath = new URL('../src/content.ts', import.meta.url);
let source = fs.readFileSync(sourcePath, 'utf8').replace(/void init\(\);\s*$/, '');
source += `
;globalThis.__parser = {
  parseStreamedToolCall,
  parseCompletionToolCall,
  completionPrompt,
  bridgeToolsEnabled,
  reserveSubmissionCooldown,
  resetSubmissionCooldown() { nextAllowedSubmissionAt = 0; }
};`;

const {code} = await transformWithOxc(source, 'content.ts', {
  lang: 'ts',
  target: 'es2022'
});
const context = {
  window: {},
  location: {
    hostname: 'chat.deepseek.com',
    href: 'https://chat.deepseek.com/a/chat/s/parser-test'
  },
  console
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(code, context);

const editCall = String.raw`<tool_call>
{"name":"edit_file","arguments":{"path":"frontend/page.tsx","old_text":"<p className=\"old\">Old</p>","new_text":"<p className=\"new\">New</p>"}</tool_call>`;
const parsedEdit = context.__parser.parseStreamedToolCall(editCall);
assert.equal(parsedEdit?.name, 'edit_file');
assert.equal(parsedEdit?.arguments.path, 'frontend/page.tsx');
assert.equal(parsedEdit?.arguments.old_text, '<p className="old">Old</p>');
assert.equal(parsedEdit?.arguments.new_text, '<p className="new">New</p>');

const writeCall = String.raw`<tool_call>
{"name":"write_file","arguments":{"path":"scripts/update.py","content":"old = """value"""\nprint("updated")\n"}}</tool_call>`;
const parsedWrite = context.__parser.parseStreamedToolCall(writeCall);
assert.equal(parsedWrite?.name, 'write_file');
assert.equal(parsedWrite?.arguments.path, 'scripts/update.py');
assert.equal(parsedWrite?.arguments.content, 'old = """value"""\nprint("updated")\n');

const customToolCall = String.raw`<tool_call>{"name":"review_project","arguments":{"path":".","depth":2}}</tool_call>`;
const parsedCustomTool = context.__parser.parseCompletionToolCall(customToolCall);
assert.equal(parsedCustomTool?.name, 'review_project');
assert.equal(parsedCustomTool?.arguments.path, '.');
assert.equal(parsedCustomTool?.arguments.depth, 2);

const reviewTool = {
  type: 'function',
  function: {
    name: 'review_project',
    description: 'Review project files.',
    parameters: {
      type: 'object',
      properties: {path: {type: 'string'}},
      required: ['path']
    }
  }
};
const forcedPrompt = context.__parser.completionPrompt(
  [
    {role: 'system', content: 'Use tools to inspect files.'},
    {role: 'user', content: 'Review this project.'}
  ],
  [reviewTool],
  {type: 'function', function: {name: 'review_project'}}
);
assert.match(forcedPrompt, /\[OPENAI_FUNCTION_TOOL_PROTOCOL_V1\]/);
assert.match(forcedPrompt, /MUST call the function named "review_project"/);
assert.match(forcedPrompt, /<tool_call>\{"name":"FUNCTION_NAME","arguments":\{\}\}<\/tool_call>/);
assert.match(forcedPrompt, /"description":"Review project files\."/);
assert.equal(context.__parser.bridgeToolsEnabled([reviewTool], 'auto'), true);
assert.equal(context.__parser.bridgeToolsEnabled([reviewTool], 'none'), false);

const continuationPrompt = context.__parser.completionPrompt(
  [
    {role: 'assistant', content: null, tool_calls: [{
      id: 'call_previous',
      type: 'function',
      function: {name: 'review_project', arguments: '{"path":"."}'}
    }]},
    {role: 'tool', tool_call_id: 'call_previous', content: '{"files":["README.md"]}'}
  ],
  [reviewTool],
  'auto'
);
assert.match(continuationPrompt, /\[ASSISTANT_TOOL_CALLS\]/);
assert.match(continuationPrompt, /\[TOOL tool_call_id=call_previous\]/);
assert.match(continuationPrompt, /README\.md/);

context.__parser.resetSubmissionCooldown();
const firstSubmission = context.__parser.reserveSubmissionCooldown(8_000, 1_000);
const queuedApiSubmission = context.__parser.reserveSubmissionCooldown(8_000, 1_100);
const queuedToolSubmission = context.__parser.reserveSubmissionCooldown(8_000, 1_200);
assert.equal(firstSubmission, 9_000);
assert.equal(queuedApiSubmission, 17_000);
assert.equal(queuedToolSubmission, 25_000);
assert.equal(queuedApiSubmission - firstSubmission, 8_000);
assert.equal(queuedToolSubmission - queuedApiSubmission, 8_000);

console.log('tool parser and OpenAI prompt regressions: PASS');
