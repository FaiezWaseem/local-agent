type AgentWindow = Window & {
  __deepseekLocalAgentLoaded?: boolean;
};

type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

type AgentStatus = {
  state: string;
  message: string;
  url: string;
  ts: number;
};

type IndicatorPosition = {
  x: number;
  y: number;
};

type IndicatorRefs = {
  host: HTMLElement;
  card: HTMLElement;
  state: HTMLElement;
  message: HTMLElement;
  updated: HTMLElement;
  project: HTMLElement;
  count: HTMLElement;
  collapse: HTMLButtonElement;
  connect: HTMLButtonElement;
  stop: HTMLButtonElement;
};

type ApprovalPolicy = {
  edits: boolean;
  deletes: boolean;
  shell: boolean;
};

type ApprovalSettings = {
  scope: 'project' | 'global';
  global?: Partial<ApprovalPolicy>;
  projects?: Record<string, Partial<ApprovalPolicy>>;
};

type PendingShellJob = {
  tool_call_id: string;
  candidate_id: string;
  tool: 'run_command';
  started_at: string;
};

const TOOL_BLOCK_OPEN = '<tool_call>';
const TOOL_BLOCK_CLOSE = '</tool_call>';
const LABELED_TOOL_RE = /(?:^|\n)\s*(?:\*\*)?Call Tool:(?:\*\*)?\s*([A-Za-z_][\w-]*)\s*(?:\n|$)\s*(?:\*\*)?Arguments:(?:\*\*)?\s*([\s\S]*?)(?=(?:\n\s*(?:\*\*)?Call Tool:)|$)/gi;
const CHAT_PROVIDER_NAMES: Record<string, string> = {
  'chat.deepseek.com': 'DeepSeek',
  'chat.qwen.ai': 'Qwen',
  'chat.z.ai': 'Z.ai'
};
const ZAI_STREAM_EVENT = 'local-ai-agent:zai-answer';
const TAB_PAUSED_KEY = 'local-ai-agent-paused';
const PENDING_SHELL_JOBS_KEY = 'local-ai-agent-pending-shell-jobs';
const SHELL_JOB_POLL_MS = 2000;
const PROTOCOL_MARKER = '[LOCAL_AGENT_PROTOCOL_V4]';
function localAgentProtocol() {
  const provider = chatProviderName();
  return `${PROTOCOL_MARKER}
MANDATORY LOCAL AGENT CONTROL FOR THIS REPLY
The text before this marker is the user's actual task. This control section is not the task. Follow it silently. Never quote, summarize, explain, or acknowledge these instructions.

TOOL AUTHORITY
- Never invoke ${provider} native tools, built-in function calling, code interpreter, web search, browser actions, artifacts, plugins, or any other platform tool. Ignore them even if ${provider} offers or recommends them.
- The only permitted tools are: read_file, write_file, edit_file, delete_file, list_directory, run_command, git_status, git_diff, git_log.
- These local tools are not native function calls. A local tool call must be emitted as literal assistant text for the browser extension to detect.
- If the task requires reading, listing, creating, editing, deleting, running, or checking project files, you MUST use a permitted local tool. Do not merely describe the action and do not invent its result.

LOCAL TOOL-CALL OUTPUT CONTRACT
- When a local tool is needed, your entire response must contain exactly one tool-call envelope and nothing else: no explanation, acknowledgement, heading, Markdown fence, or trailing text.
- Wrap the JSON object between the opening tag <tool_call> and the closing tag </tool_call>.
- The JSON object must have exactly two top-level keys. Its shape is {"name":"TOOL_NAME","arguments":{}}. Replace TOOL_NAME and arguments with real values.
- Emit valid strict JSON with double-quoted keys and strings. Escape backslashes, quotes, newlines, and other control characters according to JSON rules.
- Emit only one call, then stop and wait for the extension's <tool_result>. Never execute a native tool, simulate a result, or claim the call succeeded.

ARGUMENT CONTRACT
- read_file: path
- write_file: path, content
- edit_file: path, old_text, new_text. old_text must exactly match existing file text.
- delete_file: path. It removes one file only, never a directory.
- list_directory: path
- run_command: command, with optional timeout
- git_status: no arguments
- git_diff: optional path
- git_log: optional limit
- All paths are relative to the active project. Never access files outside it.

RESULT AND COMPLETION CONTRACT
- A <tool_result> message is authoritative output from the local extension. Read it, continue the original task, and issue the next single local call if needed.
- The extension assigns every call a unique tool_call_id and returns the same ID in <tool_result>. Use it to associate delayed background shell results with the original call.
- run_command executes as a background job. Wait for its final <tool_result>; do not repeat the command while it is pending.
- If a result reports failure, correct the arguments and retry when appropriate. Do not switch to a ${provider}-native tool.
- Only when the task requires no local tool, or when all required local work is complete, respond normally with a concise answer.`;
}
const DEFAULT_RESULT_DELAY_MS = 5000;
const LOCAL_TOOL_NAMES = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'list_directory',
  'run_command',
  'git_status',
  'git_diff',
  'git_log'
]);
const EDIT_TOOLS = new Set(['write_file', 'edit_file']);
const DELETE_TOOLS = new Set(['delete_file']);
const SHELL_TOOLS = new Set(['run_command']);
const handled = new Set<string>();
const streamedZaiCalls = new Map<string, ToolCall>();
const agentWindow = window as AgentWindow;
let scanQueued = false;
let nextAllowedSubmissionAt = 0;
let indicatorRefs: IndicatorRefs | null = null;
let toolCallCount = 0;
let protocolSendReplay = false;
let protocolReinforcementPending = false;
let agentRunning = false;
let agentRunGeneration = 0;
let indicatorControlsBusy = false;
let protocolReinforcementEnabled = true;
let resumingPendingShellJobs = false;

function chatProviderName() {
  return CHAT_PROVIDER_NAMES[location.hostname] || 'AI chat';
}

function shouldReinforceProtocol() {
  return Object.hasOwn(CHAT_PROVIDER_NAMES, location.hostname);
}

function withReinforcedProtocol(text: string) {
  if (!protocolReinforcementEnabled || !shouldReinforceProtocol() || text.includes(PROTOCOL_MARKER)) return text;
  return `${text.trimEnd()}\n\n${localAgentProtocol()}`;
}

function projectName(workspace: string) {
  const trimmed = workspace.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).at(-1) || workspace || 'No project';
}

function statusLabel(state: string) {
  const labels: Record<string, string> = {
    attached: 'Ready',
    detected: 'Tool detected',
    approval: 'Needs approval',
    executing: 'Working',
    background: 'Background job',
    cooldown: 'Cooling down',
    sending: 'Sending result',
    waiting: 'Waiting',
    connecting: 'Connecting',
    stopped: 'Stopped',
    error: 'Error'
  };
  return labels[state] || state;
}

function indicatorElements(host: HTMLElement): IndicatorRefs | null {
  const root = host.shadowRoot;
  if (!root) return null;
  const card = root.querySelector<HTMLElement>('#card');
  const state = root.querySelector<HTMLElement>('#state');
  const message = root.querySelector<HTMLElement>('#message');
  const updated = root.querySelector<HTMLElement>('#updated');
  const project = root.querySelector<HTMLElement>('#project');
  const count = root.querySelector<HTMLElement>('#count');
  const collapse = root.querySelector<HTMLButtonElement>('#collapse');
  const connect = root.querySelector<HTMLButtonElement>('#connect');
  const stop = root.querySelector<HTMLButtonElement>('#stop');
  if (!card || !state || !message || !updated || !project || !count || !collapse || !connect || !stop) return null;
  return {host, card, state, message, updated, project, count, collapse, connect, stop};
}

function clampIndicatorPosition(host: HTMLElement, position: IndicatorPosition) {
  const rect = host.getBoundingClientRect();
  return {
    x: Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8)),
    y: Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8))
  };
}

function applyIndicatorPosition(host: HTMLElement, position: IndicatorPosition) {
  const clamped = clampIndicatorPosition(host, position);
  host.style.left = `${clamped.x}px`;
  host.style.top = `${clamped.y}px`;
  host.style.right = 'auto';
  host.style.bottom = 'auto';
  return clamped;
}

function bindIndicatorDrag(refs: IndicatorRefs) {
  const handle = refs.card.querySelector<HTMLElement>('#handle');
  if (!handle) return;

  let drag: {pointerId: number; offsetX: number; offsetY: number} | null = null;

  handle.addEventListener('pointerdown', event => {
    if ((event.target as HTMLElement).closest('button')) return;
    const rect = refs.host.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    handle.setPointerCapture(event.pointerId);
    refs.card.dataset.dragging = 'true';
    event.preventDefault();
  });

  handle.addEventListener('pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    applyIndicatorPosition(refs.host, {
      x: event.clientX - drag.offsetX,
      y: event.clientY - drag.offsetY
    });
  });

  const finishDrag = async (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    refs.card.dataset.dragging = 'false';
    const rect = refs.host.getBoundingClientRect();
    await chrome.storage.local.set({indicatorPosition: {x: rect.left, y: rect.top}});
  };

  handle.addEventListener('pointerup', event => void finishDrag(event));
  handle.addEventListener('pointercancel', event => void finishDrag(event));

  refs.collapse.addEventListener('click', async () => {
    const collapsed = refs.card.dataset.collapsed !== 'true';
    refs.card.dataset.collapsed = String(collapsed);
    refs.collapse.textContent = collapsed ? '+' : '-';
    refs.collapse.setAttribute('aria-label', collapsed ? 'Expand local agent status' : 'Collapse local agent status');
    await chrome.storage.local.set({indicatorCollapsed: collapsed});
    const rect = refs.host.getBoundingClientRect();
    applyIndicatorPosition(refs.host, {x: rect.left, y: rect.top});
  });
}

function tabIsPaused() {
  try {
    return sessionStorage.getItem(TAB_PAUSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function setTabPaused(paused: boolean) {
  try {
    sessionStorage.setItem(TAB_PAUSED_KEY, String(paused));
  } catch {
    // A tab-local pause still works in memory when session storage is unavailable.
  }
}

function syncIndicatorControls() {
  if (!indicatorRefs) return;
  indicatorRefs.card.dataset.running = String(agentRunning);
  indicatorRefs.connect.disabled = agentRunning || indicatorControlsBusy;
  indicatorRefs.stop.disabled = (!agentRunning && !protocolReinforcementEnabled) || indicatorControlsBusy;
}

function setAgentRunning(running: boolean) {
  if (agentRunning !== running) {
    agentRunning = running;
    agentRunGeneration += 1;
  }
  syncIndicatorControls();
}

function bindIndicatorControls(refs: IndicatorRefs) {
  refs.connect.addEventListener('click', () => void connectAgent());
  refs.stop.addEventListener('click', () => void stopAgent());
  syncIndicatorControls();
}

async function ensureIndicator() {
  if (indicatorRefs) return indicatorRefs;

  const existing = document.getElementById('deepseek-local-agent-indicator');
  if (existing) {
    indicatorRefs = indicatorElements(existing);
    return indicatorRefs;
  }

  const host = document.createElement('div');
  host.id = 'deepseek-local-agent-indicator';
  host.style.position = 'fixed';
  host.style.right = '18px';
  host.style.bottom = '18px';
  host.style.zIndex = '2147483647';
  host.style.fontSize = 'initial';

  const root = host.attachShadow({mode: 'open'});
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      #card {
        width: 286px;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 14px;
        color: #eff7f1;
        background: rgba(20, 31, 27, .96);
        box-shadow: 0 18px 46px rgba(0,0,0,.28), 0 2px 8px rgba(0,0,0,.18);
        font: 12px/1.45 "Aptos", "Trebuchet MS", sans-serif;
        backdrop-filter: blur(16px);
        transition: width 160ms ease, box-shadow 160ms ease;
      }
      #card[data-dragging="true"] { box-shadow: 0 24px 56px rgba(0,0,0,.38); }
      #handle {
        display: flex;
        align-items: center;
        gap: 9px;
        min-height: 42px;
        padding: 8px 9px 8px 11px;
        cursor: grab;
        user-select: none;
        touch-action: none;
        border-bottom: 1px solid rgba(255,255,255,.1);
      }
      #card[data-dragging="true"] #handle { cursor: grabbing; }
      .mark {
        width: 20px;
        height: 20px;
        display: grid;
        place-items: center;
        flex: 0 0 auto;
        border-radius: 7px 7px 7px 2px;
        color: #17231e;
        background: #f06a42;
        font: 800 12px/1 Georgia, serif;
      }
      .heading { min-width: 0; flex: 1; }
      .title {
        display: block;
        color: #fff;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: .5px;
        text-transform: uppercase;
      }
      #project {
        display: block;
        overflow: hidden;
        color: #9eaea6;
        font-size: 9px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .header-dot {
        width: 8px;
        height: 8px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: #63ce9b;
        box-shadow: 0 0 0 4px rgba(99,206,155,.12);
      }
      #collapse {
        width: 25px;
        height: 25px;
        padding: 0;
        cursor: pointer;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 7px;
        color: #bdc9c3;
        background: rgba(255,255,255,.06);
        font: 700 15px/1 sans-serif;
      }
      #collapse:hover { color: #fff; background: rgba(255,255,255,.12); }
      .body { padding: 13px 14px 12px; }
      #state {
        margin-bottom: 6px;
        color: #75d9a8;
        font-size: 10px;
        font-weight: 850;
        letter-spacing: 1px;
        text-transform: uppercase;
      }
      #message {
        min-height: 36px;
        max-height: 76px;
        overflow: auto;
        color: #f3f7f4;
        font-size: 12px;
        overflow-wrap: anywhere;
      }
      .actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-top: 11px;
      }
      .action {
        min-height: 31px;
        padding: 6px 10px;
        cursor: pointer;
        border: 1px solid rgba(255,255,255,.13);
        border-radius: 9px;
        color: #e8f2ed;
        background: rgba(255,255,255,.07);
        font: 800 10px/1 "Aptos", "Trebuchet MS", sans-serif;
        letter-spacing: .45px;
        text-transform: uppercase;
        transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
      }
      .action:hover:not(:disabled) { transform: translateY(-1px); }
      .action:disabled { cursor: default; opacity: .38; }
      #connect:not(:disabled) {
        border-color: rgba(99,206,155,.4);
        color: #17231e;
        background: #75d9a8;
      }
      #stop:not(:disabled) {
        border-color: rgba(239,113,95,.38);
        color: #ffc1b7;
        background: rgba(239,113,95,.12);
      }
      .footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 10px;
        padding-top: 9px;
        border-top: 1px solid rgba(255,255,255,.09);
        color: #8fa199;
        font-size: 9px;
      }
      #count { color: #b5c2bc; font-weight: 700; }
      #card[data-state="executing"] .header-dot,
      #card[data-state="background"] .header-dot,
      #card[data-state="detected"] .header-dot,
      #card[data-state="approval"] .header-dot,
      #card[data-state="cooldown"] .header-dot,
      #card[data-state="sending"] .header-dot {
        background: #f1b74d;
        box-shadow: 0 0 0 4px rgba(241,183,77,.13);
        animation: pulse 1s ease-in-out infinite;
      }
      #card[data-state="executing"] #state,
      #card[data-state="background"] #state,
      #card[data-state="detected"] #state,
      #card[data-state="approval"] #state,
      #card[data-state="cooldown"] #state,
      #card[data-state="sending"] #state { color: #f1c46f; }
      #card[data-state="error"] .header-dot {
        background: #ef715f;
        box-shadow: 0 0 0 4px rgba(239,113,95,.14);
      }
      #card[data-state="error"] #state { color: #ff8d7d; }
      #card[data-state="stopped"] .header-dot {
        background: #7f9188;
        box-shadow: 0 0 0 4px rgba(127,145,136,.12);
      }
      #card[data-state="stopped"] #state { color: #aebdb6; }
      #card[data-collapsed="true"] { width: 196px; }
      #card[data-collapsed="true"] .body,
      #card[data-collapsed="true"] #project { display: none; }
      #card[data-collapsed="true"] #handle { border-bottom: 0; }
      @keyframes pulse { 50% { opacity: .35; transform: scale(.76); } }
    </style>
    <section id="card" data-state="attached" data-collapsed="false" aria-live="polite">
      <header id="handle">
        <span class="mark" aria-hidden="true">L</span>
        <span class="heading">
          <span class="title">Local agent</span>
          <span id="project">Connecting...</span>
        </span>
        <span class="header-dot" aria-hidden="true"></span>
        <button id="collapse" type="button" aria-label="Collapse local agent status">-</button>
      </header>
      <div class="body">
        <div id="state">Ready</div>
        <div id="message">Watching for local tool calls.</div>
        <div class="actions" aria-label="Local agent controls">
          <button id="connect" class="action" type="button">Connect</button>
          <button id="stop" class="action" type="button">Stop</button>
        </div>
        <footer class="footer">
          <span id="updated">Updated now</span>
          <span id="count">Tools: 0</span>
        </footer>
      </div>
    </section>`;

  document.documentElement.append(host);
  indicatorRefs = indicatorElements(host);
  if (!indicatorRefs) return null;

  const values = await chrome.storage.local.get([
    'workspace',
    'indicatorPosition',
    'indicatorCollapsed',
    'agentStatus'
  ]);
  indicatorRefs.project.textContent = `${chatProviderName()} - ${projectName(String(values.workspace || ''))}`;
  const collapsed = values.indicatorCollapsed === true;
  indicatorRefs.card.dataset.collapsed = String(collapsed);
  indicatorRefs.collapse.textContent = collapsed ? '+' : '-';
  indicatorRefs.collapse.setAttribute('aria-label', collapsed ? 'Expand local agent status' : 'Collapse local agent status');

  const position = values.indicatorPosition as IndicatorPosition | undefined;
  if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
    requestAnimationFrame(() => applyIndicatorPosition(host, position as IndicatorPosition));
  }

  bindIndicatorDrag(indicatorRefs);
  bindIndicatorControls(indicatorRefs);
  if (values.agentStatus) renderIndicator(values.agentStatus as AgentStatus);
  return indicatorRefs;
}

function renderIndicator(status: AgentStatus) {
  if (!indicatorRefs) return;
  indicatorRefs.card.dataset.state = status.state;
  indicatorRefs.state.textContent = statusLabel(status.state);
  indicatorRefs.message.textContent = status.message;
  indicatorRefs.updated.textContent = `Updated ${new Date(status.ts).toLocaleTimeString()}`;
  indicatorRefs.count.textContent = `Tools: ${toolCallCount}`;
}

function hash(value: string) {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return String(result);
}

function createToolCallId() {
  return `call_${crypto.randomUUID()}`;
}

function readPendingShellJobs() {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_SHELL_JOBS_KEY) || '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((job): job is PendingShellJob => {
      if (!job || typeof job !== 'object') return false;
      const candidate = job as Partial<PendingShellJob>;
      return typeof candidate.tool_call_id === 'string'
        && typeof candidate.candidate_id === 'string'
        && candidate.tool === 'run_command'
        && typeof candidate.started_at === 'string';
    });
  } catch {
    return [];
  }
}

function writePendingShellJobs(jobs: PendingShellJob[]) {
  try {
    sessionStorage.setItem(PENDING_SHELL_JOBS_KEY, JSON.stringify(jobs));
  } catch {
    // The active poll still completes when session storage is unavailable.
  }
}

function savePendingShellJob(job: PendingShellJob) {
  const jobs = readPendingShellJobs().filter(item => item.tool_call_id !== job.tool_call_id);
  writePendingShellJobs([...jobs, job]);
}

function removePendingShellJob(toolCallId: string) {
  writePendingShellJobs(readPendingShellJobs().filter(job => job.tool_call_id !== toolCallId));
}

function rememberPendingCandidates() {
  for (const job of readPendingShellJobs()) handled.add(job.candidate_id);
}

function toolCallIdentity(call: ToolCall) {
  return hash(`tool_call:${JSON.stringify({name: call.name, arguments: call.arguments || {}})}`);
}

function stripCodeFence(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function extractFirstJsonValue(value: string) {
  const text = stripCodeFence(value);
  const start = text.search(/[{\[]/);
  if (start === -1) {
    return text;
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (character === '\\') {
        escape = true;
        continue;
      }
      if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{' || character === '[') depth += 1;
    if (character === '}' || character === ']') depth -= 1;

    if (depth === 0) {
      return text.slice(start, index + 1);
    }
  }

  return text;
}

function ensureArgumentsObject(value: unknown) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function parseToolBlock(payload: string) {
  const parsed = JSON.parse(extractFirstJsonValue(payload)) as ToolCall;
  if (!parsed || typeof parsed.name !== 'string') {
    throw new Error('Tool payload must contain a string "name".');
  }

  return {
    name: parsed.name,
    arguments: ensureArgumentsObject(parsed.arguments)
  } satisfies ToolCall;
}

function parseProviderJsonToolCall(payload: string) {
  if (!shouldReinforceProtocol()) return null;

  try {
    const parsed = JSON.parse(stripCodeFence(payload)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (Object.keys(parsed).sort().join(',') !== 'arguments,name') return null;
    if (typeof parsed.name !== 'string' || !LOCAL_TOOL_NAMES.has(parsed.name)) return null;

    return {
      name: parsed.name,
      arguments: ensureArgumentsObject(parsed.arguments)
    } satisfies ToolCall;
  } catch {
    return null;
  }
}

function installZaiStreamBridge() {
  if (location.hostname !== 'chat.z.ai') return;

  document.addEventListener(ZAI_STREAM_EVENT, event => {
    if (!agentRunning) return;
    const answer = (event as CustomEvent<unknown>).detail;
    if (typeof answer !== 'string') return;

    const call = parseProviderJsonToolCall(answer);
    if (!call) return;

    const id = toolCallIdentity(call);
    streamedZaiCalls.set(id, call);
    queueScan();
  });
}

function parseArgumentsPayload(payload: string) {
  return ensureArgumentsObject(JSON.parse(extractFirstJsonValue(payload)));
}

type ExtractedToolBlock = {
  payload: string;
  repaired: boolean;
};

function findJsonStart(text: string, start: number, closeAt: number) {
  let index = start;
  while (index < closeAt && /\s/.test(text[index])) index += 1;

  if (text.startsWith('```', index)) {
    index += 3;
    if (text.slice(index, index + 4).toLowerCase() === 'json') index += 4;
    while (index < closeAt && /\s/.test(text[index])) index += 1;
  }

  return text[index] === '{' || text[index] === '[' ? index : -1;
}

function extractToolBlocks(text: string) {
  const blocks: ExtractedToolBlock[] = [];
  const lowerText = text.toLowerCase();
  let cursor = 0;

  while (cursor < text.length) {
    const openAt = lowerText.indexOf(TOOL_BLOCK_OPEN, cursor);
    if (openAt === -1) break;

    const bodyStart = openAt + TOOL_BLOCK_OPEN.length;
    const firstCloseAt = lowerText.indexOf(TOOL_BLOCK_CLOSE, bodyStart);
    if (firstCloseAt === -1) break;

    const jsonStart = findJsonStart(text, bodyStart, firstCloseAt);
    if (jsonStart === -1) {
      cursor = firstCloseAt + TOOL_BLOCK_CLOSE.length;
      continue;
    }

    const expectedClosers: string[] = [];
    let inString = false;
    let escaped = false;
    let syntaxError = false;
    let jsonEnd = -1;
    let closeAt = -1;

    for (let index = jsonStart; index < text.length; index += 1) {
      const character = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === '\\') {
          escaped = true;
          continue;
        }
        if (character === '"') inString = false;
        continue;
      }

      if (lowerText.startsWith(TOOL_BLOCK_CLOSE, index)) {
        closeAt = index;
        break;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '{') expectedClosers.push('}');
      if (character === '[') expectedClosers.push(']');
      if (character === '}' || character === ']') {
        if (expectedClosers.pop() !== character) {
          syntaxError = true;
          closeAt = lowerText.indexOf(TOOL_BLOCK_CLOSE, index);
          break;
        }
        if (!expectedClosers.length) {
          jsonEnd = index + 1;
          closeAt = lowerText.indexOf(TOOL_BLOCK_CLOSE, jsonEnd);
          break;
        }
      }
    }

    if (closeAt === -1) break;

    if (jsonEnd !== -1) {
      blocks.push({payload: text.slice(jsonStart, jsonEnd), repaired: false});
    } else {
      const canRepair = !syntaxError && !inString && expectedClosers.length > 0 && expectedClosers.length <= 4;
      const suffix = canRepair ? [...expectedClosers].reverse().join('') : '';
      let payload = text.slice(jsonStart, closeAt).trim();
      if (canRepair) {
        payload = payload.replace(/```\s*$/i, '').trimEnd();
        payload = payload.replace(/[),;]+$/, '').trimEnd();
      }
      blocks.push({
        payload: payload + suffix,
        repaired: canRepair
      });
    }

    cursor = closeAt + TOOL_BLOCK_CLOSE.length;
  }

  return blocks;
}

async function updateStatus(state: string, message: string) {
  const status: AgentStatus = {
    state,
    message,
    url: location.href,
    ts: Date.now()
  };
  await ensureIndicator();
  renderIndicator(status);
  await chrome.storage.local.set({agentStatus: status});
}

async function readDaemonResponse(response: Response) {
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(body.error || `Daemon returned status ${response.status}.`));
  }
  return body;
}

async function connectAgent() {
  if (agentRunning || indicatorControlsBusy) return;

  indicatorControlsBusy = true;
  syncIndicatorControls();

  try {
    await updateStatus('connecting', 'Connecting with the saved token and project...');
    const values = await chrome.storage.local.get(['token', 'workspace']);
    const token = String(values.token || '').trim();
    const workspace = String(values.workspace || '').trim();
    if (!token || !workspace) {
      throw new Error('Open the extension popup once to save a pairing token and project path.');
    }

    const connection = await readDaemonResponse(await fetch('http://127.0.0.1:43121/connect', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({token})
    }));
    if (connection.ok !== true) throw new Error(String(connection.error || 'Connection failed.'));

    const workspaceResult = await readDaemonResponse(await fetch('http://127.0.0.1:43121/workspace', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({path: workspace})
    }));
    if (workspaceResult.ok !== true) throw new Error(String(workspaceResult.error || 'Workspace setup failed.'));

    const connectedWorkspace = String(workspaceResult.workspace || workspace);
    setTabPaused(false);
    protocolReinforcementEnabled = true;
    setAgentRunning(true);
    nextAllowedSubmissionAt = 0;
    await chrome.storage.local.set({workspace: connectedWorkspace, connectedWorkspace});
    if (indicatorRefs) {
      indicatorRefs.project.textContent = `${chatProviderName()} - ${projectName(connectedWorkspace)}`;
    }
    await updateStatus('waiting', `Connected to ${projectName(connectedWorkspace)}. Waiting for a local tool call.`);
    rememberPendingCandidates();
    void resumePendingShellJobs();
    queueScan();
  } catch (error) {
    setAgentRunning(false);
    await updateStatus('error', `Connection failed: ${(error as Error).message}`);
  } finally {
    indicatorControlsBusy = false;
    syncIndicatorControls();
  }
}

async function stopAgent() {
  if ((!agentRunning && !protocolReinforcementEnabled) || indicatorControlsBusy) return;

  setTabPaused(true);
  protocolReinforcementEnabled = false;
  setAgentRunning(false);
  streamedZaiCalls.clear();
  protocolReinforcementPending = false;
  protocolSendReplay = false;
  nextAllowedSubmissionAt = 0;

  const composer = findComposer();
  if (composer && composerText(composer).includes('<tool_result>')) {
    setComposer(composer, '');
  }

  await updateStatus('stopped', 'Stopped on this tab. Connect to resume local tools.');
}

function isVisible(element: HTMLElement) {
  return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

function policyFrom(value: unknown): ApprovalPolicy {
  const candidate = value as Partial<ApprovalPolicy> | undefined;
  return {
    edits: candidate?.edits === true,
    deletes: candidate?.deletes === true,
    shell: candidate?.shell === true
  };
}

async function activeApprovalPolicy() {
  const values = await chrome.storage.local.get(['approvalSettings', 'workspace']);
  const settings = values.approvalSettings as ApprovalSettings | undefined;
  if (settings?.scope === 'global') {
    return policyFrom(settings.global);
  }
  return policyFrom(settings?.projects?.[String(values.workspace || '')]);
}

function confirmationDetail(call: ToolCall) {
  if (call.name === 'run_command') return String(call.arguments?.command || '');
  return String(call.arguments?.path || '');
}

async function pollShellJob(toolCallId: string, token: string) {
  const generation = agentRunGeneration;
  const stillRunning = () => agentRunning && generation === agentRunGeneration;

  while (stillRunning()) {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:43121/tool/${encodeURIComponent(toolCallId)}`, {
        headers: {authorization: `Bearer ${token}`}
      });
    } catch (error) {
      await updateStatus(
        'background',
        `run_command ${toolCallId} is still pending. The daemon is unavailable; retrying in ${SHELL_JOB_POLL_MS / 1000}s.`
      );
      await new Promise(resolve => setTimeout(resolve, SHELL_JOB_POLL_MS));
      continue;
    }

    const result = await readDaemonResponse(response);
    if (result.pending !== true) return result;

    const startedAt = Date.parse(String(result.started_at || ''));
    const elapsedSeconds = Number.isFinite(startedAt)
      ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      : 0;
    await updateStatus(
      'background',
      `run_command ${toolCallId} is running in the background (${elapsedSeconds}s). Waiting for completion.`
    );
    await new Promise(resolve => setTimeout(resolve, SHELL_JOB_POLL_MS));
  }

  throw new Error(`Local agent stopped while ${toolCallId} is still running in the background.`);
}

async function execute(call: ToolCall, callId: string, candidateId: string) {
  const {token} = await chrome.storage.local.get('token');
  if (!token) {
    throw new Error('Open the extension popup and pair with the local daemon first.');
  }

  const policy = await activeApprovalPolicy();
  const needsConfirmation = (EDIT_TOOLS.has(call.name) && !policy.edits)
    || (DELETE_TOOLS.has(call.name) && !policy.deletes)
    || (SHELL_TOOLS.has(call.name) && !policy.shell);

  if (needsConfirmation) {
    await updateStatus('approval', `Waiting for approval to run ${call.name} (${callId}).`);
    if (!confirm(`${chatProviderName()} requests local tool: ${call.name}\n${confirmationDetail(call)}\n\nAllow?`)) {
      return {success: false, pending: false, tool_call_id: callId, error: 'User denied tool call'};
    }
    await updateStatus('executing', `${call.name} approved (${callId}). Running locally.`);
  }

  const result = await readDaemonResponse(await fetch('http://127.0.0.1:43121/tool', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({name: call.name, arguments: call.arguments || {}, tool_call_id: callId})
  }));

  if (call.name === 'run_command' && result.pending === true) {
    savePendingShellJob({
      tool_call_id: callId,
      candidate_id: candidateId,
      tool: 'run_command',
      started_at: String(result.started_at || new Date().toISOString())
    });
    return pollShellJob(callId, String(token));
  }

  return result;
}

function findComposer(): HTMLElement | null {
  const candidates = [...document.querySelectorAll(
    'textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]'
  )] as HTMLElement[];
  return candidates.filter(element => {
    if (!isVisible(element)) return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    if (element.getAttribute('aria-disabled') === 'true') return false;
    if (element instanceof HTMLTextAreaElement && element.disabled) return false;
    if (element instanceof HTMLInputElement && element.disabled) return false;
    if (element instanceof HTMLInputElement && element.type === 'search') return false;
    const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('placeholder') || ''}`;
    if (/search|filter/i.test(label)) return false;
    return true;
  }).sort((left, right) => {
    const score = (element: HTMLElement) => {
      const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('placeholder') || ''}`;
      const chatHint = /message|ask|prompt|qwen|deepseek|glm/i.test(label) ? 5000 : 0;
      const editorHint = element instanceof HTMLTextAreaElement || element.isContentEditable ? 10000 : 0;
      return chatHint + editorHint + element.getBoundingClientRect().bottom;
    };
    return score(left) - score(right);
  }).at(-1) || null;
}

function setComposer(element: HTMLElement, text: string) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(element, text);
    element.dispatchEvent(new Event('input', {bubbles: true}));
    return;
  }

  element.focus();
  document.execCommand('selectAll', false);
  if (!document.execCommand('insertText', false, text)) {
    element.textContent = text;
  }
  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: 'insertText',
    data: text
  }));
}

function composerText(element: HTMLElement) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value;
  return element.innerText || element.textContent || '';
}

function resultIsPending() {
  const composer = findComposer();
  return Boolean(composer && composerText(composer).includes('<tool_result>'));
}

function isClickable(element: HTMLElement) {
  if (!isVisible(element)) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  if (element instanceof HTMLButtonElement && element.disabled) return false;
  return true;
}

function controlLabel(element: HTMLElement) {
  return [
    element.getAttribute('aria-label'),
    element.getAttribute('data-testid'),
    element.getAttribute('data-test-id'),
    element.getAttribute('title'),
    element.textContent
  ].filter(Boolean).join(' ');
}

function findSendControl(composer: HTMLElement) {
  let root: HTMLElement | null = composer.parentElement;

  for (let depth = 0; root && depth < 7; depth += 1, root = root.parentElement) {
    const controls = [...root.querySelectorAll('button,[role="button"]')] as HTMLElement[];
    const candidates = controls.filter(isClickable);
    const explicit = candidates.find(candidate => /\b(send|submit)\b/i.test(controlLabel(candidate)));
    if (explicit) return explicit;

    const likely = candidates.filter(candidate => {
      return !/attach|upload|image|voice|microphone|clear|stop/i.test(controlLabel(candidate));
    });
    if (depth >= 2 && likely.length) return likely.at(-1) || null;
  }

  return null;
}

function pressEnter(composer: HTMLElement) {
  composer.focus();
  const eventOptions: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true
  };
  composer.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
  composer.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
}

async function reinforceComposerAndReplay(composer: HTMLElement, replay: () => void) {
  if (!protocolReinforcementEnabled || protocolSendReplay || protocolReinforcementPending) return;
  const generation = agentRunGeneration;

  const currentText = composerText(composer);
  if (!currentText.trim() || currentText.includes(PROTOCOL_MARKER)) {
    replay();
    return;
  }

  protocolReinforcementPending = true;
  try {
    setComposer(composer, withReinforcedProtocol(currentText));
    await updateStatus('waiting', `${chatProviderName()} tool instructions reinforced for this message.`).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 150));
    if (!protocolReinforcementEnabled || generation !== agentRunGeneration) return;
    protocolReinforcementPending = false;
    protocolSendReplay = true;
    replay();
  } finally {
    protocolReinforcementPending = false;
    window.setTimeout(() => {
      protocolSendReplay = false;
    }, 0);
  }
}

function installProtocolReinforcement() {
  if (!shouldReinforceProtocol()) return;

  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) {
      return;
    }
    if (!protocolReinforcementEnabled) return;

    const composer = findComposer();
    const target = event.target as Node | null;
    if (!composer || !target || (target !== composer && !composer.contains(target))) return;
    if (protocolSendReplay) return;
    if (protocolReinforcementPending) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!composerText(composer).trim() || composerText(composer).includes(PROTOCOL_MARKER)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void reinforceComposerAndReplay(composer, () => pressEnter(composer));
  }, true);

  document.addEventListener('click', event => {
    if (!protocolReinforcementEnabled) return;
    const composer = findComposer();
    const target = event.target as Node | null;
    if (!composer || !target) return;

    const sendControl = findSendControl(composer);
    if (!sendControl || (target !== sendControl && !sendControl.contains(target))) return;
    if (protocolSendReplay) return;
    if (protocolReinforcementPending) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!composerText(composer).trim() || composerText(composer).includes(PROTOCOL_MARKER)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void reinforceComposerAndReplay(composer, () => sendControl.click());
  }, true);

  document.addEventListener('submit', event => {
    if (!protocolReinforcementEnabled) return;
    const composer = findComposer();
    const form = event.target as HTMLFormElement;
    if (!composer || composer.closest('form') !== form) return;
    if (protocolSendReplay) return;
    if (protocolReinforcementPending) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!composerText(composer).trim() || composerText(composer).includes(PROTOCOL_MARKER)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    void reinforceComposerAndReplay(composer, () => form.requestSubmit());
  }, true);
}

async function configuredResultDelayMs() {
  const {resultDelayMs} = await chrome.storage.local.get('resultDelayMs');
  const parsed = Number(resultDelayMs);
  if (!Number.isFinite(parsed)) return DEFAULT_RESULT_DELAY_MS;
  return Math.min(30000, Math.max(3000, parsed));
}

async function submitResult(delayMs: number) {
  if (!agentRunning) return false;
  const generation = agentRunGeneration;
  const stillRunning = () => agentRunning && generation === agentRunGeneration;
  const scheduledAt = Math.max(Date.now() + delayMs, nextAllowedSubmissionAt);
  nextAllowedSubmissionAt = scheduledAt + delayMs;

  while (scheduledAt > Date.now()) {
    if (!stillRunning()) return false;
    const remainingMs = scheduledAt - Date.now();
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    await updateStatus(
      'cooldown',
      `Tool result ready. Sending automatically in ${seconds} second${seconds === 1 ? '' : 's'}.`
    );
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, remainingMs)));
  }

  if (!stillRunning()) return false;
  await updateStatus('sending', `Sending the tool result to ${chatProviderName()} now.`);

  let composer = findComposer();
  if (!composer) return false;

  pressEnter(composer);
  await new Promise(resolve => setTimeout(resolve, 450));
  if (!stillRunning()) return false;
  if (!resultIsPending()) return true;

  composer = findComposer();
  const sendControl = composer && findSendControl(composer);
  if (sendControl) {
    sendControl.click();
    await new Promise(resolve => setTimeout(resolve, 450));
    if (!stillRunning()) return false;
    if (!resultIsPending()) return true;
  }

  composer = findComposer();
  const form = composer?.closest('form');
  if (form) {
    form.requestSubmit();
    await new Promise(resolve => setTimeout(resolve, 450));
  }

  return !resultIsPending();
}

async function feed(result: unknown) {
  if (!agentRunning) throw new Error('Local agent is stopped on this tab.');
  const text = withReinforcedProtocol(
    `<tool_result>\n${JSON.stringify(result)}\n</tool_result>\nContinue the original task using the required local-agent protocol.`
  );
  const composer = findComposer();
  if (!composer) {
    throw new Error(`${chatProviderName()} composer not found on this tab.`);
  }

  setComposer(composer, text);
  const delayMs = await configuredResultDelayMs();
  if (!await submitResult(delayMs)) {
    throw new Error(`Could not auto-submit the tool result. ${chatProviderName()} UI selectors may need updating.`);
  }
}

type ToolCandidate = {
  id: string;
  call?: ToolCall;
  error?: string;
  repaired?: boolean;
  toolName?: string;
};

function isUserAuthored(element: HTMLElement) {
  return Boolean(element.closest([
    '[data-message-author-role="user" i]',
    '[data-role="user" i]',
    '[data-author="user" i]',
    '[data-testid*="user-message" i]',
    '[class~="user-message" i]'
  ].join(',')));
}

function latestRenderedJsonCandidate() {
  const candidates = new Map<string, ToolCandidate>();
  const nodes = document.querySelectorAll('pre,code');

  for (const node of nodes) {
    const element = node as HTMLElement;
    if (element.closest('form,textarea,[role="textbox"],[contenteditable]:not([contenteditable="false"])')) continue;
    if (isUserAuthored(element)) continue;

    const text = (element.innerText || element.textContent || '').trim();
    if (!text) continue;

    const call = parseProviderJsonToolCall(text);
    if (!call) continue;

    const id = toolCallIdentity(call);
    candidates.delete(id);
    candidates.set(id, {id, call});
  }

  return [...candidates.values()].reverse().find(candidate => !handled.has(candidate.id));
}

function inferToolName(payload: string) {
  return /["']name["']\s*:\s*["']([A-Za-z_][\w-]*)["']/i.exec(payload)?.[1];
}

function findToolCandidates() {
  const renderedJsonCandidate = latestRenderedJsonCandidate();
  if (renderedJsonCandidate) return [renderedJsonCandidate];

  const candidates = new Map<string, ToolCandidate>();
  const nodes = document.querySelectorAll('pre,code,article,div,p,span,tool_call,tool-call');

  for (const node of nodes) {
    const element = node as HTMLElement;
    if (element.closest('form,textarea,[role="textbox"],[contenteditable]:not([contenteditable="false"])')) continue;
    if (isUserAuthored(element)) continue;

    const text = (element.innerText || element.textContent || '').trim();
    if (!text) continue;

    const renderedJsonCall = parseProviderJsonToolCall(text);
    if (renderedJsonCall) {
      const id = toolCallIdentity(renderedJsonCall);
      candidates.delete(id);
      candidates.set(id, {id, call: renderedJsonCall});
    }

    for (const block of extractToolBlocks(text)) {
      const {payload} = block;
      try {
        const call = parseToolBlock(payload);
        const id = toolCallIdentity(call);
        candidates.delete(id);
        candidates.set(id, {id, call, repaired: block.repaired});
      } catch (error) {
        const id = hash(`tool_block_error:${payload}`);
        candidates.delete(id);
        candidates.set(id, {
          id,
          toolName: inferToolName(payload),
          error: `Found <tool_call> markup but could not parse its JSON: ${(error as Error).message}`
        });
      }
    }

    for (const match of text.matchAll(LABELED_TOOL_RE)) {
      const toolName = match[1];
      const argsPayload = match[2];
      const id = hash(`labeled_tool:${toolName}\n${argsPayload}`);
      candidates.delete(id);
      try {
        candidates.set(id, {
          id,
          call: {
            name: toolName,
            arguments: parseArgumentsPayload(argsPayload)
          }
        });
      } catch (error) {
        candidates.set(id, {
          id,
          toolName,
          error: `Found "Call Tool" output for ${toolName} but could not parse Arguments JSON: ${(error as Error).message}`
        });
      }
    }
  }

  for (const [id, call] of streamedZaiCalls) {
    candidates.delete(id);
    candidates.set(id, {id, call});
  }

  const latestCandidate = [...candidates.values()].reverse().find(candidate => !handled.has(candidate.id));
  return latestCandidate ? [latestCandidate] : [];
}

async function returnFailureToAI(
  tool: string,
  phase: 'parse' | 'execution',
  error: string,
  callId = createToolCallId()
) {
  if (!agentRunning) return;
  const generation = agentRunGeneration;
  const stillRunning = () => agentRunning && generation === agentRunGeneration;

  try {
    await feed({
      tool,
      tool_call_id: callId,
      success: false,
      phase,
      error,
      retryable: true,
      instruction: phase === 'parse'
        ? 'Retry with exactly one tool call containing valid JSON.'
        : 'Review the error and retry with corrected tool arguments if appropriate.'
    });
    if (!stillRunning()) return;
    await updateStatus(
      'waiting',
      `Reported the ${phase} failure for ${tool} (${callId}) to ${chatProviderName()}. Waiting for a corrected call.`
    );
  } catch (deliveryError) {
    if (!stillRunning()) return;
    const deliveryMessage = (deliveryError as Error).message;
    await updateStatus('error', `${error} Could not return this failure to ${chatProviderName()}: ${deliveryMessage}`);
    console.error('[Local AI Agent] Could not return failure to the chat.', deliveryError);
  }
}

async function resumePendingShellJobs() {
  if (!agentRunning || resumingPendingShellJobs) return;

  const jobs = readPendingShellJobs();
  for (const job of jobs) handled.add(job.candidate_id);
  if (!jobs.length) return;

  resumingPendingShellJobs = true;
  try {
    const {token} = await chrome.storage.local.get('token');
    if (!token) {
      await updateStatus('error', 'Cannot resume background shell jobs until a pairing token is saved.');
      return;
    }

    for (const job of jobs) {
      if (!agentRunning) return;

      let result: Record<string, unknown>;
      try {
        result = await pollShellJob(job.tool_call_id, String(token));
      } catch (error) {
        if (!agentRunning) return;
        const message = (error as Error).message;
        removePendingShellJob(job.tool_call_id);
        await returnFailureToAI(job.tool, 'execution', message, job.tool_call_id);
        continue;
      }

      if (!agentRunning) return;
      try {
        await feed({tool: job.tool, ...result});
        removePendingShellJob(job.tool_call_id);
        if (!agentRunning) return;
        await updateStatus(
          'waiting',
          `Finished ${job.tool} (${job.tool_call_id}). Waiting for the next <tool_call>.`
        );
      } catch (error) {
        if (!agentRunning) return;
        await updateStatus(
          'error',
          `${job.tool} (${job.tool_call_id}) finished, but its result could not be returned to ${chatProviderName()}: ${(error as Error).message}`
        );
        return;
      }
    }
  } finally {
    resumingPendingShellJobs = false;
  }
}

async function scan() {
  if (!agentRunning) return;
  const generation = agentRunGeneration;
  const stillRunning = () => agentRunning && generation === agentRunGeneration;
  const candidates = findToolCandidates();
  if (!candidates.length) return;

  for (const candidate of candidates) {
    if (!stillRunning()) return;
    const {id} = candidate;
    if (handled.has(id)) continue;
    handled.add(id);
    streamedZaiCalls.delete(id);
    const callId = createToolCallId();

    if (candidate.error) {
      toolCallCount += 1;
      await updateStatus('error', `${candidate.error} Tool call ID: ${callId}.`);
      if (!stillRunning()) return;
      await returnFailureToAI(candidate.toolName || 'unknown', 'parse', candidate.error, callId);
      continue;
    }

    const call = candidate.call;
    if (!call) continue;

    toolCallCount += 1;
    const recoveryNote = candidate.repaired ? ' Recovered missing trailing JSON delimiter.' : '';
    await updateStatus('executing', `Tool call triggered: ${call.name} (${callId}).${recoveryNote} Running locally.`);

    let result: Record<string, unknown>;
    try {
      result = await execute(call, callId, id);
    } catch (error) {
      if (!stillRunning()) return;
      const message = (error as Error).message;
      removePendingShellJob(callId);
      await updateStatus('error', `${call.name} (${callId}) failed: ${message}`);
      await returnFailureToAI(call.name, 'execution', message, callId);
      console.error('[Local AI Agent]', error);
      continue;
    }

    if (!stillRunning()) return;
    try {
      await feed({tool: call.name, ...result});
      removePendingShellJob(callId);
      if (!stillRunning()) return;
      await updateStatus('waiting', `Finished ${call.name} (${callId}). Waiting for the next <tool_call>.`);
    } catch (error) {
      if (!stillRunning()) return;
      const message = (error as Error).message;
      await updateStatus(
        'error',
        `${call.name} (${callId}) finished, but its result could not be returned to ${chatProviderName()}: ${message}`
      );
      console.error('[Local AI Agent]', error);
    }
  }
}

function queueScan() {
  if (!agentRunning || scanQueued) return;
  scanQueued = true;
  window.setTimeout(() => {
    scanQueued = false;
    if (agentRunning) void scan();
  }, 150);
}

function installConnectionStorageSync() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    const workspace = changes.workspace?.newValue;
    if (workspace && indicatorRefs) {
      indicatorRefs.project.textContent = `${chatProviderName()} - ${projectName(String(workspace))}`;
    }

    if (!changes.token && !changes.workspace && !changes.connectedWorkspace) return;
    void chrome.storage.local.get(['token', 'workspace', 'connectedWorkspace']).then(async values => {
      const activeWorkspace = values.connectedWorkspace || values.workspace;
      const hasConnection = Boolean(values.token && activeWorkspace);
      if (!hasConnection) {
        if (agentRunning) {
          setAgentRunning(false);
          await updateStatus('stopped', 'Connection settings were removed. Connect after saving them again.');
        }
        return;
      }

      if (!tabIsPaused() && !agentRunning) {
        setAgentRunning(true);
        await updateStatus('waiting', `Connected to ${projectName(String(activeWorkspace))}. Waiting for a local tool call.`);
        rememberPendingCandidates();
        void resumePendingShellJobs();
        queueScan();
      }
    }).catch(() => undefined);
  });
}

async function init() {
  await ensureIndicator();

  if (agentWindow.__deepseekLocalAgentLoaded) {
    await updateStatus('attached', 'Content script already attached to this tab. Use Connect or Stop here.');
    return;
  }

  agentWindow.__deepseekLocalAgentLoaded = true;
  const connection = await chrome.storage.local.get(['token', 'workspace', 'connectedWorkspace']);
  const activeWorkspace = connection.connectedWorkspace || connection.workspace;
  protocolReinforcementEnabled = !tabIsPaused();
  setAgentRunning(Boolean(connection.token && activeWorkspace) && protocolReinforcementEnabled);
  rememberPendingCandidates();
  installProtocolReinforcement();
  installZaiStreamBridge();
  installConnectionStorageSync();

  new MutationObserver(() => queueScan()).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true
  });

  if (agentRunning) {
    await updateStatus('waiting', `Connected to ${projectName(String(activeWorkspace))}. Waiting for a local tool call.`);
    void resumePendingShellJobs();
    queueScan();
  } else {
    const message = connection.token && activeWorkspace
      ? 'Stopped on this tab. Connect to resume local tools.'
      : 'Not connected. Save a token and project in the popup, then connect here.';
    await updateStatus('stopped', message);
  }
}

void init();
