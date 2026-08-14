import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {transformWithOxc} from 'vite';

const sourcePath = new URL('../src/content.ts', import.meta.url);
let source = fs.readFileSync(sourcePath, 'utf8').replace(/void init\(\);\s*$/, '');
source += '\n;globalThis.__parser = {parseStreamedToolCall};';

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

console.log('edit_file and write_file parser regressions: PASS');
