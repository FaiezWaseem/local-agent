import Fastify from 'fastify';
import cors from '@fastify/cors';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import {fsTool} from './tools/filesystem.js';
import {git} from './tools/git.js';
import {log, history} from './db/history.js';
import {getShellJob, startShellJob} from './jobs.js';

const app = Fastify({logger: true});
await app.register(cors, {
  origin: [
    /^chrome-extension:\/\//,
    'https://chat.deepseek.com',
    'https://chat.qwen.ai',
    'https://chat.z.ai'
  ]
});

const cfgDir = path.join(os.homedir(), '.deepseek-local');
fs.mkdirSync(cfgDir, {recursive: true});
const tokenFile = path.join(cfgDir, 'token');
let TOKEN = process.env.DEEPSEEK_LOCAL_TOKEN || '';
if (!TOKEN) {
  if (fs.existsSync(tokenFile)) {
    TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
  } else {
    TOKEN = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(tokenFile, TOKEN, {mode: 0o600});
  }
}

let workspace = path.resolve(process.env.DEEPSEEK_WORKSPACE || process.cwd());

function auth(req: any, rep: any) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    rep.code(401).send({error: 'unauthorized'});
    return false;
  }
  return true;
}

function toolCallId(value: unknown) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{8,100}$/.test(candidate)
    ? candidate
    : `call_${crypto.randomUUID()}`;
}

app.get('/health', async () => ({ok: true, workspace}));

app.post('/connect', async (req: any, rep) => {
  if (req.body?.token !== TOKEN) return rep.code(401).send({error: 'bad token'});
  return {ok: true, workspace};
});

app.post('/workspace', async (req: any, rep) => {
  if (!auth(req, rep)) return;
  const nextWorkspace = path.resolve(req.body.path);
  if (!fs.existsSync(nextWorkspace) || !fs.statSync(nextWorkspace).isDirectory()) {
    return rep.code(400).send({error: 'workspace must be an existing directory'});
  }
  workspace = nextWorkspace;
  return {ok: true, workspace};
});

app.get('/history', async (req: any, rep) => {
  if (!auth(req, rep)) return;
  return {items: history(50)};
});

app.get('/tool/:toolCallId', async (req: any, rep) => {
  if (!auth(req, rep)) return;
  const job = getShellJob(String(req.params.toolCallId || ''));
  if (!job) {
    return rep.code(404).send({
      success: false,
      tool_call_id: req.params.toolCallId,
      error: 'Background tool call was not found. The daemon may have restarted.'
    });
  }
  return job;
});

app.post('/tool', async (req: any, rep) => {
  if (!auth(req, rep)) return;
  const {name, arguments: args = {}} = req.body || {};
  const id = toolCallId(req.body?.tool_call_id);

  if (name === 'run_command') {
    return startShellJob(workspace, args, id);
  }

  try {
    let result;
    if (['read_file', 'write_file', 'edit_file', 'delete_file', 'list_directory'].includes(name)) {
      result = await fsTool(workspace, name, args);
    } else if (['git_status', 'git_diff', 'git_log'].includes(name)) {
      result = await git(workspace, name, args);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
    log(id, name, args, result, true);
    return {success: true, pending: false, tool_call_id: id, result};
  } catch (error) {
    const message = (error as Error).message;
    log(id, name, args, {error: message}, false);
    return {success: false, pending: false, tool_call_id: id, error: message};
  }
});

app.listen({host: '127.0.0.1', port: Number(process.env.PORT || 43121)}).then(() => {
  console.log(`\nLocal AI Agent ready\nWorkspace: ${workspace}\nPairing token: ${TOKEN}\n`);
});
