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
  tool?: string;
  toolCallId?: string;
  command?: string;
};

type ActiveTool = {
  name: string;
  callId: string;
  command: string;
};

type DaemonHistoryItem = {
  id: number;
  ts: string;
  call_id?: string;
  tool: string;
  args: string;
  result: string;
  ok: number;
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
  activeTool: HTMLElement;
  command: HTMLElement;
  statusPanel: HTMLElement;
  historyPanel: HTMLElement;
  statusTab: HTMLButtonElement;
  historyTab: HTMLButtonElement;
  historyList: HTMLElement;
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
  command?: string;
};

type BridgeChatMessage = {
  role: string;
  content: string | Array<{type?: string; text?: string}>;
};

type BridgeServerMessage = {
  type?: string;
  request_id?: string;
  model?: string;
  messages?: BridgeChatMessage[];
  provider?: string;
  error?: string;
};

type ActiveBridgeCompletion = {
  id: string;
  model: string;
  sequence: number;
  content: string;
  finalAnswer: string;
  streamStarted: boolean;
};

const TOOL_BLOCK_OPEN = '<tool_call>';
const TOOL_BLOCK_CLOSE = '</tool_call>';
const LABELED_TOOL_RE = /(?:^|\n)\s*(?:\*\*)?Call Tool:(?:\*\*)?\s*([A-Za-z_][\w-]*)\s*(?:\n|$)\s*(?:\*\*)?Arguments:(?:\*\*)?\s*([\s\S]*?)(?=(?:\n\s*(?:\*\*)?Call Tool:)|$)/gi;
const CHAT_PROVIDER_NAMES: Record<string, string> = {
  'chat.deepseek.com': 'DeepSeek',
  'chat.qwen.ai': 'Qwen',
  'chat.z.ai': 'Z.ai'
};
const DEEPSEEK_STREAM_EVENT = 'local-ai-agent:deepseek-answer';
const ZAI_STREAM_EVENT = 'local-ai-agent:zai-answer';
const PROVIDER_STREAM_STATE_EVENT = 'local-ai-agent:provider-stream-state';
const PROVIDER_STREAM_DELTA_EVENT = 'local-ai-agent:provider-stream-delta';
const COMPLETION_BRIDGE_URL = 'ws://127.0.0.1:43121/ws/extension';
const COMPLETION_BRIDGE_PROTOCOL = 'local-ai-agent';
const COMPLETION_BRIDGE_CLIENT_KEY = 'local-ai-agent-completion-bridge-client';
const COMPLETION_BRIDGE_RECONNECT_MAX_MS = 15_000;
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
const streamedProviderCalls = new Map<string, ToolCall>();
const streamedDomSuppressions = new Set<string>();
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
let activeTool: ActiveTool | null = null;
let streamedCallSequence = 0;
let providerResponseDepth = 0;
let completionBridgeSocket: WebSocket | null = null;
let completionBridgeReconnectTimer = 0;
let completionBridgeHeartbeatTimer = 0;
let completionBridgeReconnectAttempt = 0;
let activeBridgeCompletion: ActiveBridgeCompletion | null = null;
let bridgeResponseSuppressionActive = false;

function chatProviderName() {
  return CHAT_PROVIDER_NAMES[location.hostname] || 'AI chat';
}

function completionBridgeProvider() {
  if (location.hostname === 'chat.deepseek.com') return 'deepseek';
  if (location.hostname === 'chat.z.ai') return 'zai';
  return undefined;
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
    generating: 'AI responding',
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
  const activeTool = root.querySelector<HTMLElement>('#active-tool');
  const command = root.querySelector<HTMLElement>('#active-command');
  const statusPanel = root.querySelector<HTMLElement>('#status-panel');
  const historyPanel = root.querySelector<HTMLElement>('#history-panel');
  const statusTab = root.querySelector<HTMLButtonElement>('#status-tab');
  const historyTab = root.querySelector<HTMLButtonElement>('#history-tab');
  const historyList = root.querySelector<HTMLElement>('#history-list');
  const collapse = root.querySelector<HTMLButtonElement>('#collapse');
  const connect = root.querySelector<HTMLButtonElement>('#connect');
  const stop = root.querySelector<HTMLButtonElement>('#stop');
  if (!card || !state || !message || !updated || !project || !count || !activeTool || !command
    || !statusPanel || !historyPanel || !statusTab || !historyTab || !historyList
    || !collapse || !connect || !stop) return null;
  return {
    host,
    card,
    state,
    message,
    updated,
    project,
    count,
    activeTool,
    command,
    statusPanel,
    historyPanel,
    statusTab,
    historyTab,
    historyList,
    collapse,
    connect,
    stop
  };
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

function toolCommandLine(call: ToolCall) {
  const args = call.arguments || {};
  if (call.name === 'run_command') return `$ ${String(args.command || '')}`;

  const path = typeof args.path === 'string' ? ` ${JSON.stringify(args.path)}` : '';
  if (call.name === 'edit_file') {
    const oldText = String(args.old_text ?? args.old_content ?? '');
    const newText = String(args.new_text ?? args.new_content ?? '');
    return `> edit_file${path} --old ${oldText.length} chars --new ${newText.length} chars`;
  }
  if (call.name === 'write_file') {
    return `> write_file${path} --content ${String(args.content ?? '').length} chars`;
  }
  if (call.name === 'git_log' && args.limit != null) return `> git_log --limit ${String(args.limit)}`;
  return `> ${call.name}${path}`;
}

function renderActiveTool() {
  if (!indicatorRefs) return;
  indicatorRefs.activeTool.textContent = activeTool?.name || 'Idle';
  indicatorRefs.activeTool.title = activeTool?.callId || 'No active tool call';
  indicatorRefs.command.textContent = activeTool?.command || 'No tool is running.';
  indicatorRefs.command.dataset.active = String(Boolean(activeTool));
}

function setActiveTool(call: ToolCall, callId: string) {
  activeTool = {name: call.name, callId, command: toolCommandLine(call)};
  renderActiveTool();
}

function clearActiveTool(callId?: string) {
  if (callId && activeTool?.callId !== callId) return;
  activeTool = null;
  renderActiveTool();
}

function historyPayload(value: string) {
  let formatted = value;
  try {
    formatted = JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    // Older history rows may contain plain text.
  }
  const limit = 120000;
  return formatted.length > limit
    ? `${formatted.slice(0, limit)}\n\n... truncated in monitor (${formatted.length - limit} more characters)`
    : formatted;
}

function renderToolHistory(items: DaemonHistoryItem[]) {
  if (!indicatorRefs) return;
  const fragment = document.createDocumentFragment();

  for (const item of items) {
    const details = document.createElement('details');
    details.className = 'history-item';

    const summary = document.createElement('summary');
    const tool = document.createElement('span');
    tool.className = 'history-tool';
    tool.textContent = item.tool || 'unknown';
    const meta = document.createElement('span');
    meta.className = item.ok ? 'history-meta success' : 'history-meta failure';
    meta.textContent = `${item.ok ? 'OK' : 'Failed'} - ${new Date(item.ts).toLocaleTimeString()}`;
    summary.append(tool, meta);

    const callId = document.createElement('code');
    callId.className = 'history-id';
    callId.textContent = item.call_id || `history-${item.id}`;

    const inputLabel = document.createElement('div');
    inputLabel.className = 'io-label';
    inputLabel.textContent = 'Input';
    const input = document.createElement('pre');
    input.textContent = historyPayload(item.args || '{}');

    const outputLabel = document.createElement('div');
    outputLabel.className = 'io-label';
    outputLabel.textContent = 'Output';
    const output = document.createElement('pre');
    output.textContent = historyPayload(item.result || '{}');

    details.append(summary, callId, inputLabel, input, outputLabel, output);
    fragment.append(details);
  }

  indicatorRefs.historyList.replaceChildren(fragment);
  if (!items.length) indicatorRefs.historyList.textContent = 'No completed tool calls yet.';
}

async function loadToolHistory() {
  if (!indicatorRefs) return;
  indicatorRefs.historyList.textContent = 'Loading tool-call history...';
  try {
    const {token} = await chrome.storage.local.get('token');
    if (!token) throw new Error('Connect first to view daemon history.');
    const response = await readDaemonResponse(await fetch('http://127.0.0.1:43121/history', {
      headers: {authorization: `Bearer ${token}`}
    }));
    renderToolHistory(Array.isArray(response.items) ? response.items as DaemonHistoryItem[] : []);
  } catch (error) {
    if (indicatorRefs) indicatorRefs.historyList.textContent = `History unavailable: ${(error as Error).message}`;
  }
}

function showIndicatorPanel(panel: 'status' | 'history') {
  if (!indicatorRefs) return;
  const historyVisible = panel === 'history';
  indicatorRefs.card.dataset.view = panel;
  indicatorRefs.statusPanel.hidden = historyVisible;
  indicatorRefs.historyPanel.hidden = !historyVisible;
  indicatorRefs.statusTab.dataset.active = String(!historyVisible);
  indicatorRefs.historyTab.dataset.active = String(historyVisible);
  if (historyVisible) void loadToolHistory();
}

function refreshVisibleHistory() {
  if (indicatorRefs?.card.dataset.view === 'history') void loadToolHistory();
}

function bindIndicatorControls(refs: IndicatorRefs) {
  refs.connect.addEventListener('click', () => void connectAgent());
  refs.stop.addEventListener('click', () => void stopAgent());
  refs.statusTab.addEventListener('click', () => showIndicatorPanel('status'));
  refs.historyTab.addEventListener('click', () => showIndicatorPanel('history'));
  refs.historyPanel.querySelector<HTMLButtonElement>('#history-refresh')
    ?.addEventListener('click', () => void loadToolHistory());
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
        width: min(330px, calc(100vw - 16px));
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
      #active-tool {
        max-width: 92px;
        overflow: hidden;
        padding: 3px 7px;
        border: 1px solid rgba(255,255,255,.11);
        border-radius: 999px;
        color: #b9c8c0;
        background: rgba(255,255,255,.06);
        font: 800 9px/1 "Aptos", "Trebuchet MS", sans-serif;
        letter-spacing: .25px;
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
      .body { padding: 10px 14px 12px; }
      [hidden] { display: none !important; }
      .tabs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px;
        margin-bottom: 11px;
        padding: 3px;
        border-radius: 9px;
        background: rgba(255,255,255,.055);
      }
      .tab {
        min-height: 27px;
        cursor: pointer;
        border: 0;
        border-radius: 7px;
        color: #8fa199;
        background: transparent;
        font: 800 9px/1 "Aptos", "Trebuchet MS", sans-serif;
        letter-spacing: .55px;
        text-transform: uppercase;
      }
      .tab[data-active="true"] {
        color: #eff7f1;
        background: rgba(255,255,255,.1);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,.08);
      }
      #active-command {
        max-height: 76px;
        margin: 0 0 10px;
        overflow: auto;
        padding: 8px 9px;
        border: 1px solid rgba(117,217,168,.15);
        border-radius: 9px;
        color: #98aaa1;
        background: #101a16;
        font: 10px/1.45 Consolas, "Courier New", monospace;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }
      #active-command[data-active="true"] { color: #c9f4dc; }
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
      .history-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 9px;
        color: #c8d5ce;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: .45px;
        text-transform: uppercase;
      }
      #history-refresh {
        cursor: pointer;
        border: 0;
        color: #75d9a8;
        background: transparent;
        font: 800 9px/1 "Aptos", "Trebuchet MS", sans-serif;
        text-transform: uppercase;
      }
      #history-list {
        max-height: min(430px, calc(100vh - 190px));
        overflow: auto;
        color: #91a39a;
      }
      .history-item {
        margin-bottom: 6px;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,.09);
        border-radius: 9px;
        background: rgba(255,255,255,.035);
      }
      .history-item summary {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 9px;
        cursor: pointer;
        list-style: none;
      }
      .history-item summary::-webkit-details-marker { display: none; }
      .history-item[open] summary { border-bottom: 1px solid rgba(255,255,255,.08); }
      .history-tool {
        overflow: hidden;
        color: #edf6f1;
        font-weight: 800;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .history-meta { flex: 0 0 auto; font-size: 8px; font-weight: 800; text-transform: uppercase; }
      .history-meta.success { color: #75d9a8; }
      .history-meta.failure { color: #ff8d7d; }
      .history-id {
        display: block;
        overflow: hidden;
        padding: 7px 9px 0;
        color: #82958b;
        font: 8px/1.3 Consolas, monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .io-label {
        padding: 8px 9px 4px;
        color: #f1c46f;
        font-size: 8px;
        font-weight: 850;
        letter-spacing: .7px;
        text-transform: uppercase;
      }
      .history-item pre {
        max-height: 190px;
        margin: 0 7px 8px;
        overflow: auto;
        padding: 8px;
        border-radius: 7px;
        color: #c8d5ce;
        background: #101a16;
        font: 9px/1.4 Consolas, "Courier New", monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
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
      #card[data-state="executing"] #active-tool,
      #card[data-state="background"] #active-tool,
      #card[data-state="approval"] #active-tool,
      #card[data-state="cooldown"] #active-tool,
      #card[data-state="sending"] #active-tool { color: #f1c46f; border-color: rgba(241,183,77,.24); }
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
      #card[data-collapsed="true"] { width: min(250px, calc(100vw - 16px)); }
      #card[data-collapsed="true"] .body,
      #card[data-collapsed="true"] #project { display: none; }
      #card[data-collapsed="true"] #handle { border-bottom: 0; }
      @keyframes pulse { 50% { opacity: .35; transform: scale(.76); } }
    </style>
    <section id="card" data-state="attached" data-view="status" data-collapsed="false" aria-live="polite">
      <header id="handle">
        <span class="mark" aria-hidden="true">L</span>
        <span class="heading">
          <span class="title">Local agent</span>
          <span id="project">Connecting...</span>
        </span>
        <span id="active-tool" title="No active tool call">Idle</span>
        <span class="header-dot" aria-hidden="true"></span>
        <button id="collapse" type="button" aria-label="Collapse local agent status">-</button>
      </header>
      <div class="body">
        <nav class="tabs" aria-label="Local agent views">
          <button id="status-tab" class="tab" data-active="true" type="button">Status</button>
          <button id="history-tab" class="tab" data-active="false" type="button">History</button>
        </nav>
        <section id="status-panel">
          <pre id="active-command" data-active="false">No tool is running.</pre>
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
        </section>
        <section id="history-panel" hidden>
          <div class="history-head"><span>Past tool calls</span><button id="history-refresh" type="button">Refresh</button></div>
          <div id="history-list">Open this tab to load history.</div>
        </section>
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
  else renderActiveTool();
  return indicatorRefs;
}

function renderIndicator(status: AgentStatus) {
  if (!indicatorRefs) return;
  indicatorRefs.card.dataset.state = status.state;
  indicatorRefs.state.textContent = statusLabel(status.state);
  indicatorRefs.message.textContent = status.message;
  indicatorRefs.updated.textContent = `Updated ${new Date(status.ts).toLocaleTimeString()}`;
  indicatorRefs.count.textContent = `Tools: ${toolCallCount}`;
  if (activeTool) {
    renderActiveTool();
  } else {
    indicatorRefs.activeTool.textContent = status.tool || 'Idle';
    indicatorRefs.activeTool.title = status.toolCallId || 'No active tool call';
    indicatorRefs.command.textContent = status.command || 'No tool is running.';
    indicatorRefs.command.dataset.active = String(Boolean(status.tool));
  }
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

type StringField = {
  key: string;
  keyStart: number;
  valueStart: number;
};

function stringFields(payload: string, keys: string[]) {
  const matches: StringField[] = [];
  for (const key of keys) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"`, 'g');
    for (const match of payload.matchAll(pattern)) {
      if (match.index == null) continue;
      matches.push({key, keyStart: match.index, valueStart: match.index + match[0].length});
    }
  }
  return matches.sort((left, right) => left.keyStart - right.keyStart);
}

function decodeRenderedJsonString(value: string) {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\' || index + 1 >= value.length) {
      decoded += character;
      continue;
    }

    const escaped = value[index + 1];
    const simpleEscapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t'
    };
    if (Object.hasOwn(simpleEscapes, escaped)) {
      decoded += simpleEscapes[escaped];
      index += 1;
      continue;
    }

    if (escaped === 'u') {
      const codePoint = value.slice(index + 2, index + 6);
      if (/^[0-9a-f]{4}$/i.test(codePoint)) {
        decoded += String.fromCharCode(Number.parseInt(codePoint, 16));
        index += 5;
        continue;
      }
    }

    decoded += `\\${escaped}`;
    index += 1;
  }
  return decoded;
}

function fieldValueBefore(payload: string, field: StringField, nextField: StringField) {
  const value = payload.slice(field.valueStart, nextField.keyStart);
  const boundary = /"\s*,\s*$/.exec(value);
  if (!boundary) throw new Error(`Could not recover the ${field.key} field boundary.`);
  return decodeRenderedJsonString(value.slice(0, boundary.index));
}

function finalFieldValue(payload: string, field: StringField) {
  const value = payload.slice(field.valueStart).trimEnd();
  const boundary = /"\s*}\s*}\s*$/.exec(value);
  if (!boundary) throw new Error(`Could not recover the ${field.key} field boundary.`);
  return decodeRenderedJsonString(value.slice(0, boundary.index));
}

function recoverRenderedTextToolCall(payload: string): ToolCall | null {
  const text = stripCodeFence(payload).trim();
  const name = /"name"\s*:\s*"([A-Za-z_][\w-]*)"/.exec(text)?.[1];
  if (name !== 'edit_file' && name !== 'write_file') return null;

  const pathField = stringFields(text, ['path'])[0];
  if (!pathField) return null;

  if (name === 'write_file') {
    const contentField = stringFields(text, ['content']).at(-1);
    if (!contentField || contentField.keyStart <= pathField.keyStart) return null;
    return {
      name,
      arguments: {
        path: fieldValueBefore(text, pathField, contentField),
        content: finalFieldValue(text, contentField)
      }
    };
  }

  const oldField = stringFields(text, ['old_text', 'old_content']).find(field => field.keyStart > pathField.keyStart);
  const newField = stringFields(text, ['new_text', 'new_content'])
    .filter(field => field.keyStart > (oldField?.keyStart ?? -1))
    .at(-1);
  if (!oldField || !newField) return null;

  return {
    name,
    arguments: {
      path: fieldValueBefore(text, pathField, oldField),
      old_text: fieldValueBefore(text, oldField, newField),
      new_text: finalFieldValue(text, newField)
    }
  };
}

function parseToolBlock(payload: string) {
  let parsed: ToolCall;
  try {
    parsed = JSON.parse(extractFirstJsonValue(payload)) as ToolCall;
  } catch (error) {
    const recovered = recoverRenderedTextToolCall(payload);
    if (!recovered) throw error;
    parsed = recovered;
  }
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

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripCodeFence(payload)) as Record<string, unknown>;
  } catch {
    try {
      const recovered = recoverRenderedTextToolCall(payload);
      if (!recovered) return null;
      parsed = recovered as unknown as Record<string, unknown>;
    } catch {
      // Enveloped edit/write calls are recovered after their <tool_call> block is extracted.
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (Object.keys(parsed).sort().join(',') !== 'arguments,name') return null;
  if (typeof parsed.name !== 'string' || !LOCAL_TOOL_NAMES.has(parsed.name)) return null;

  return {
    name: parsed.name,
    arguments: ensureArgumentsObject(parsed.arguments)
  } satisfies ToolCall;
}

function parseStreamedToolCall(answer: string) {
  let providerCall: ToolCall | null = null;
  try {
    providerCall = parseProviderJsonToolCall(answer);
  } catch {
    // A provider-level parse must never prevent the envelope parser from running.
  }
  if (providerCall) return providerCall;

  const blocks = extractToolBlocks(answer);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const {payload, rawPayload} = blocks[index];
    try {
      return parseToolBlock(payload);
    } catch {
      try {
        return parseToolBlock(rawPayload);
      } catch {
        // A malformed stream call will still be reported by the DOM scanner.
      }
    }
  }

  return null;
}

function installProviderStreamBridge() {
  const streamEvent = location.hostname === 'chat.deepseek.com'
    ? DEEPSEEK_STREAM_EVENT
    : location.hostname === 'chat.z.ai'
      ? ZAI_STREAM_EVENT
      : undefined;
  if (!streamEvent) return;

  document.addEventListener(PROVIDER_STREAM_STATE_EVENT, event => {
    const state = (event as CustomEvent<unknown>).detail;
    if (state === 'started') {
      providerResponseDepth += 1;
      if (activeBridgeCompletion) activeBridgeCompletion.streamStarted = true;
      if (agentRunning) {
        const message = activeBridgeCompletion
          ? `${chatProviderName()} is streaming API completion ${activeBridgeCompletion.id}.`
          : `${chatProviderName()} is generating a response. Local actions are paused.`;
        void updateStatus('generating', message);
      }
      return;
    }

    if (state === 'finished') {
      providerResponseDepth = Math.max(0, providerResponseDepth - 1);
      if (activeBridgeCompletion?.streamStarted) {
        void finishBridgeCompletion();
        return;
      }
      if (providerResponseDepth === 0) {
        if (agentRunning) {
          void updateStatus('waiting', `${chatProviderName()} finished responding. Checking for a local tool call.`);
        }
        queueScan();
      }
    }
  });

  document.addEventListener(PROVIDER_STREAM_DELTA_EVENT, event => {
    const delta = (event as CustomEvent<unknown>).detail;
    if (!activeBridgeCompletion?.streamStarted || typeof delta !== 'string' || !delta) return;
    activeBridgeCompletion.content += delta;
    activeBridgeCompletion.sequence += 1;
    sendCompletionBridgeMessage({
      type: 'completion.delta',
      request_id: activeBridgeCompletion.id,
      sequence: activeBridgeCompletion.sequence,
      delta
    });
  });

  document.addEventListener(streamEvent, event => {
    if (!agentRunning) return;
    const answer = (event as CustomEvent<unknown>).detail;
    if (typeof answer !== 'string') return;

    if (activeBridgeCompletion?.streamStarted) {
      activeBridgeCompletion.finalAnswer = answer;
      return;
    }

    const call = parseStreamedToolCall(answer);
    if (!call) return;

    const baseId = toolCallIdentity(call);
    const id = `stream:${++streamedCallSequence}:${baseId}`;
    streamedProviderCalls.set(id, call);
    queueScan();
  });
}

function parseArgumentsPayload(payload: string) {
  return ensureArgumentsObject(JSON.parse(extractFirstJsonValue(payload)));
}

type ExtractedToolBlock = {
  payload: string;
  rawPayload: string;
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
    const rawPayload = text.slice(jsonStart, firstCloseAt).replace(/```\s*$/i, '').trim();

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
      blocks.push({payload: text.slice(jsonStart, jsonEnd), rawPayload, repaired: false});
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
        rawPayload,
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
    ts: Date.now(),
    tool: activeTool?.name,
    toolCallId: activeTool?.callId,
    command: activeTool?.command
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

function extensionContextWasInvalidated(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /extension context (?:has been )?invalidated|context invalidated/i.test(message);
}

function reloadInvalidatedExtensionTab() {
  setAgentRunning(false);
  renderIndicator({
    state: 'error',
    message: 'The extension was updated. Reloading this chat tab to attach the new version...',
    url: location.href,
    ts: Date.now()
  });
  window.setTimeout(() => location.reload(), 750);
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
    void openCompletionBridge();
    queueScan();
  } catch (error) {
    if (extensionContextWasInvalidated(error)) {
      reloadInvalidatedExtensionTab();
      return;
    }
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
  closeCompletionBridge();
  streamedProviderCalls.clear();
  streamedDomSuppressions.clear();
  protocolReinforcementPending = false;
  protocolSendReplay = false;
  nextAllowedSubmissionAt = 0;
  clearActiveTool();

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
      started_at: String(result.started_at || new Date().toISOString()),
      command: toolCommandLine(call)
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

function findProviderStopControl() {
  const controls = [...document.querySelectorAll<HTMLElement>('button,[role="button"]')];
  return controls.find(control => {
    if (!isVisible(control)) return false;
    const label = controlLabel(control).trim();
    return /^(?:(?:stop|cancel)\s*)+$/i.test(label)
      || /\b(stop|cancel)\s+(generating|generation|response)\b/i.test(label);
  }) || null;
}

function providerUiIsGenerating() {
  return Boolean(findProviderStopControl());
}

function providerResponseIsGenerating() {
  return providerResponseDepth > 0 || providerUiIsGenerating();
}

async function waitForProviderResponse(generation = agentRunGeneration) {
  let announced = false;
  while (agentRunning && generation === agentRunGeneration && providerResponseIsGenerating()) {
    if (!announced) {
      announced = true;
      await updateStatus(
        'generating',
        `${chatProviderName()} is still generating. The pending local-agent message will wait.`
      );
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  if (!agentRunning || generation !== agentRunGeneration) {
    throw new Error('Local agent stopped while waiting for the AI response to finish.');
  }
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

function completionBridgeClientId() {
  try {
    const existing = sessionStorage.getItem(COMPLETION_BRIDGE_CLIENT_KEY);
    if (existing) return existing;
    const created = `tab_${crypto.randomUUID()}`;
    sessionStorage.setItem(COMPLETION_BRIDGE_CLIENT_KEY, created);
    return created;
  } catch {
    return `tab_${crypto.randomUUID()}`;
  }
}

function sendCompletionBridgeMessage(message: Record<string, unknown>) {
  if (completionBridgeSocket?.readyState !== WebSocket.OPEN) return false;
  try {
    completionBridgeSocket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function clearCompletionBridgeTimers() {
  if (completionBridgeReconnectTimer) window.clearTimeout(completionBridgeReconnectTimer);
  if (completionBridgeHeartbeatTimer) window.clearInterval(completionBridgeHeartbeatTimer);
  completionBridgeReconnectTimer = 0;
  completionBridgeHeartbeatTimer = 0;
}

function scheduleCompletionBridgeReconnect() {
  if (!agentRunning || !completionBridgeProvider() || completionBridgeReconnectTimer) return;
  const delay = Math.min(COMPLETION_BRIDGE_RECONNECT_MAX_MS, 500 * (2 ** completionBridgeReconnectAttempt));
  completionBridgeReconnectAttempt += 1;
  completionBridgeReconnectTimer = window.setTimeout(() => {
    completionBridgeReconnectTimer = 0;
    void openCompletionBridge();
  }, delay);
}

function cancelActiveBridgeCompletion(message = 'Completion bridge disconnected.') {
  const completion = activeBridgeCompletion;
  if (!completion) return;
  activeBridgeCompletion = null;
  findProviderStopControl()?.click();
  void suppressCompletedBridgeResponse();
  if (agentRunning) void updateStatus('error', `${message} Request ${completion.id} was cancelled.`);
}

function closeCompletionBridge() {
  clearCompletionBridgeTimers();
  const socket = completionBridgeSocket;
  completionBridgeSocket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Local agent stopped');
  cancelActiveBridgeCompletion('Completion bridge closed.');
}

function bridgeMessageText(message: BridgeChatMessage) {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n');
}

function completionPrompt(messages: BridgeChatMessage[]) {
  const normalized = messages
    .map(message => ({role: message.role.toUpperCase(), content: bridgeMessageText(message)}))
    .filter(message => message.content.trim());
  if (normalized.length === 1 && normalized[0].role === 'USER') return normalized[0].content;

  return [
    'Continue the conversation below and answer the final user message. Treat SYSTEM and DEVELOPER entries as instructions.',
    '',
    ...normalized.flatMap(message => [`[${message.role}]`, message.content, ''])
  ].join('\n').trimEnd();
}

async function bridgeSubmissionObserved(composer: HTMLElement, prompt: string, timeoutMs: number) {
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    if (providerResponseIsGenerating()) return true;
    if (composerText(composer).trim() !== prompt.trim()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

async function submitBridgePrompt(prompt: string) {
  const composer = findComposer();
  if (!composer) throw new Error(`${chatProviderName()} composer was not found.`);
  setComposer(composer, prompt);
  protocolSendReplay = true;

  try {
    pressEnter(composer);
    if (await bridgeSubmissionObserved(composer, prompt, 800)) return;

    const sendControl = findSendControl(composer);
    if (sendControl) {
      sendControl.click();
      if (await bridgeSubmissionObserved(composer, prompt, 800)) return;
    }

    const form = composer.closest('form');
    if (form) {
      form.requestSubmit();
      if (await bridgeSubmissionObserved(composer, prompt, 800)) return;
    }
  } finally {
    protocolSendReplay = false;
  }

  throw new Error(`Could not submit the completion prompt through the ${chatProviderName()} UI.`);
}

async function waitForBridgeStream(requestId: string) {
  const expiresAt = Date.now() + 30_000;
  while (Date.now() < expiresAt) {
    if (activeBridgeCompletion?.id !== requestId) return;
    if (activeBridgeCompletion.streamStarted) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${chatProviderName()} did not start a completion stream within 30 seconds.`);
}

async function handleBridgeCompletionRequest(message: BridgeServerMessage) {
  const requestId = String(message.request_id || '');
  const messages = Array.isArray(message.messages) ? message.messages : [];
  if (!requestId || !messages.length) return;

  if (!agentRunning || activeBridgeCompletion || activeTool || providerResponseIsGenerating()
    || bridgeResponseSuppressionActive || resultIsPending()) {
    sendCompletionBridgeMessage({
      type: 'completion.error',
      request_id: requestId,
      error: `${chatProviderName()} tab is busy with another local or provider operation.`
    });
    return;
  }

  activeBridgeCompletion = {
    id: requestId,
    model: String(message.model || `${completionBridgeProvider()}-web`),
    sequence: -1,
    content: '',
    finalAnswer: '',
    streamStarted: false
  };
  sendCompletionBridgeMessage({type: 'completion.accepted', request_id: requestId});

  try {
    await updateStatus('sending', `Submitting API completion ${requestId} to ${chatProviderName()}.`);
    const prompt = completionPrompt(messages);
    if (!prompt.trim()) throw new Error('The completion request does not contain any supported text content.');
    await submitBridgePrompt(prompt);
    await waitForBridgeStream(requestId);
  } catch (error) {
    if (activeBridgeCompletion?.id !== requestId) return;
    activeBridgeCompletion = null;
    sendCompletionBridgeMessage({
      type: 'completion.error',
      request_id: requestId,
      error: (error as Error).message
    });
    await updateStatus('error', `API completion ${requestId} failed: ${(error as Error).message}`);
  }
}

async function suppressCompletedBridgeResponse() {
  if (bridgeResponseSuppressionActive) {
    while (bridgeResponseSuppressionActive) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return;
  }
  bridgeResponseSuppressionActive = true;
  try {
    await new Promise(resolve => setTimeout(resolve, 500));
    for (const candidate of findToolCandidates()) {
      handled.add(candidate.id);
      streamedProviderCalls.delete(candidate.id);
    }
  } finally {
    bridgeResponseSuppressionActive = false;
  }
}

async function finishBridgeCompletion() {
  const completion = activeBridgeCompletion;
  if (!completion) return;
  const content = completion.finalAnswer || completion.content;
  const toolCall = parseStreamedToolCall(content);
  if (toolCall) streamedDomSuppressions.add(toolCallIdentity(toolCall));
  await suppressCompletedBridgeResponse();
  if (activeBridgeCompletion?.id !== completion.id) return;
  activeBridgeCompletion = null;
  sendCompletionBridgeMessage({
    type: 'completion.completed',
    request_id: completion.id,
    content,
    finish_reason: 'stop'
  });
  if (agentRunning) {
    await updateStatus('waiting', `API completion ${completion.id} finished. Waiting for a local tool call.`);
  }
}

function handleCompletionBridgeMessage(event: MessageEvent<string>) {
  let message: BridgeServerMessage;
  try {
    message = JSON.parse(String(event.data)) as BridgeServerMessage;
  } catch {
    return;
  }

  if (message.type === 'completion.request') {
    void handleBridgeCompletionRequest(message);
  } else if (message.type === 'completion.cancel' && message.request_id === activeBridgeCompletion?.id) {
    cancelActiveBridgeCompletion('API client cancelled the completion.');
  }
}

async function openCompletionBridge() {
  const provider = completionBridgeProvider();
  if (!agentRunning || !provider) return;
  if (completionBridgeSocket && completionBridgeSocket.readyState <= WebSocket.OPEN) return;

  const {token} = await chrome.storage.local.get('token');
  const pairingToken = String(token || '').trim();
  if (!pairingToken || !agentRunning) return;

  clearCompletionBridgeTimers();
  let socket: WebSocket;
  try {
    socket = new WebSocket(COMPLETION_BRIDGE_URL, [COMPLETION_BRIDGE_PROTOCOL, `token.${pairingToken}`]);
  } catch {
    scheduleCompletionBridgeReconnect();
    return;
  }
  completionBridgeSocket = socket;

  socket.addEventListener('open', () => {
    if (completionBridgeSocket !== socket) return;
    completionBridgeReconnectAttempt = 0;
    sendCompletionBridgeMessage({
      type: 'bridge.register',
      client_id: completionBridgeClientId(),
      provider,
      url: location.href
    });
    completionBridgeHeartbeatTimer = window.setInterval(() => {
      sendCompletionBridgeMessage({type: 'bridge.ping', ts: Date.now()});
    }, 20_000);
  });

  socket.addEventListener('message', handleCompletionBridgeMessage as EventListener);
  socket.addEventListener('close', () => {
    if (completionBridgeSocket !== socket) return;
    completionBridgeSocket = null;
    if (completionBridgeHeartbeatTimer) window.clearInterval(completionBridgeHeartbeatTimer);
    completionBridgeHeartbeatTimer = 0;
    cancelActiveBridgeCompletion();
    scheduleCompletionBridgeReconnect();
  });
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
    if (!protocolSendReplay && (providerResponseIsGenerating() || activeBridgeCompletion || bridgeResponseSuppressionActive)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void updateStatus('generating', `Wait for ${chatProviderName()} to finish before sending another message.`);
      return;
    }
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
    if (!protocolSendReplay && (providerResponseIsGenerating() || activeBridgeCompletion || bridgeResponseSuppressionActive)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void updateStatus('generating', `Wait for ${chatProviderName()} to finish before sending another message.`);
      return;
    }
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
    if (!protocolSendReplay && (providerResponseIsGenerating() || activeBridgeCompletion || bridgeResponseSuppressionActive)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void updateStatus('generating', `Wait for ${chatProviderName()} to finish before sending another message.`);
      return;
    }
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
  await waitForProviderResponse(generation);
  await updateStatus('sending', `Sending the tool result to ${chatProviderName()} now.`);

  let composer = findComposer();
  if (!composer) return false;

  pressEnter(composer);
  await new Promise(resolve => setTimeout(resolve, 450));
  if (!stillRunning()) return false;
  if (providerResponseIsGenerating()) return true;
  if (!resultIsPending()) return true;

  await waitForProviderResponse(generation);
  composer = findComposer();
  const sendControl = composer && findSendControl(composer);
  if (sendControl) {
    sendControl.click();
    await new Promise(resolve => setTimeout(resolve, 450));
    if (!stillRunning()) return false;
    if (providerResponseIsGenerating()) return true;
    if (!resultIsPending()) return true;
  }

  await waitForProviderResponse(generation);
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
  await waitForProviderResponse();
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
  baseId: string;
  source: 'dom' | 'stream';
  call?: ToolCall;
  error?: string;
  repaired?: boolean;
  toolName?: string;
};

type SourcedCandidate = {
  baseId: string;
  element: HTMLElement;
  order: number;
  value: Omit<ToolCandidate, 'id' | 'baseId' | 'source'>;
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

function candidateMessageSource(element: HTMLElement) {
  return element.closest<HTMLElement>([
    '[data-message-id]',
    '[data-msg-id]',
    '[data-message-author-role="assistant" i]',
    '[data-role="assistant" i]',
    '[data-author="assistant" i]',
    '[data-testid*="assistant-message" i]',
    '[class~="assistant-message" i]'
  ].join(',')) || element;
}

function elementPath(element: HTMLElement) {
  const parts: number[] = [];
  let current: HTMLElement | null = element;
  while (current?.parentElement && parts.length < 18) {
    const siblings = current.parentElement.children;
    parts.push(Array.prototype.indexOf.call(siblings, current));
    current = current.parentElement;
  }
  return parts.reverse().join('.');
}

function candidateSourceKey(element: HTMLElement) {
  const source = candidateMessageSource(element);
  for (const attribute of ['data-message-id', 'data-msg-id']) {
    const value = source.getAttribute(attribute);
    if (value) return `${attribute}:${value}`;
  }
  return `path:${elementPath(source)}`;
}

function latestSourcedCandidate(records: SourcedCandidate[]) {
  const groups = new Map<string, SourcedCandidate[]>();
  for (const record of records) {
    const group = groups.get(record.baseId) || [];
    group.push(record);
    groups.set(record.baseId, group);
  }

  const canonical: SourcedCandidate[] = [];
  for (const group of groups.values()) {
    const byElement = new Map<HTMLElement, SourcedCandidate>();
    for (const record of group) byElement.set(record.element, record);
    const unique = [...byElement.values()];
    canonical.push(...unique.filter(record => !unique.some(other => (
      other.element !== record.element && record.element.contains(other.element)
    ))));
  }

  const latest = canonical.sort((left, right) => left.order - right.order).at(-1);
  if (!latest) return undefined;

  const id = hash(`occurrence:${latest.baseId}:${candidateSourceKey(latest.element)}`);
  if (streamedDomSuppressions.has(latest.baseId)) {
    streamedDomSuppressions.delete(latest.baseId);
    handled.add(id);
    return undefined;
  }
  if (handled.has(id)) return undefined;
  return {id, baseId: latest.baseId, source: 'dom', ...latest.value} satisfies ToolCandidate;
}

function latestRenderedJsonCandidate() {
  const candidates: SourcedCandidate[] = [];
  const nodes = document.querySelectorAll('pre,code');
  let order = 0;

  for (const node of nodes) {
    order += 1;
    const element = node as HTMLElement;
    if (element.closest('form,textarea,[role="textbox"],[contenteditable]:not([contenteditable="false"])')) continue;
    if (isUserAuthored(element)) continue;

    const text = (element.innerText || element.textContent || '').trim();
    if (!text) continue;

    const call = parseProviderJsonToolCall(text);
    if (!call) continue;

    candidates.push({baseId: toolCallIdentity(call), element, order, value: {call}});
  }

  return latestSourcedCandidate(candidates);
}

function inferToolName(payload: string) {
  return /["']name["']\s*:\s*["']([A-Za-z_][\w-]*)["']/i.exec(payload)?.[1];
}

function findToolCandidates(): ToolCandidate[] {
  const latestStream = [...streamedProviderCalls.entries()].at(-1);
  if (latestStream) {
    const [id, call] = latestStream;
    if (!handled.has(id)) {
      return [{id, baseId: toolCallIdentity(call), source: 'stream', call} satisfies ToolCandidate];
    }
    return [];
  }

  const renderedJsonCandidate = latestRenderedJsonCandidate();
  if (renderedJsonCandidate) return [renderedJsonCandidate];

  const candidates: SourcedCandidate[] = [];
  const nodes = document.querySelectorAll('pre,code,article,div,p,span,tool_call,tool-call');
  let order = 0;

  for (const node of nodes) {
    order += 1;
    const element = node as HTMLElement;
    if (element.closest('form,textarea,[role="textbox"],[contenteditable]:not([contenteditable="false"])')) continue;
    if (isUserAuthored(element)) continue;

    const text = (element.innerText || element.textContent || '').trim();
    if (!text) continue;

    const renderedJsonCall = parseProviderJsonToolCall(text);
    if (renderedJsonCall) {
      candidates.push({
        baseId: toolCallIdentity(renderedJsonCall),
        element,
        order,
        value: {call: renderedJsonCall}
      });
    }

    for (const block of extractToolBlocks(text)) {
      const {payload, rawPayload} = block;
      try {
        let call: ToolCall;
        try {
          call = parseToolBlock(payload);
        } catch (error) {
          if (rawPayload === payload) throw error;
          call = parseToolBlock(rawPayload);
        }
        candidates.push({
          baseId: toolCallIdentity(call),
          element,
          order,
          value: {call, repaired: block.repaired}
        });
      } catch (error) {
        candidates.push({
          baseId: hash(`tool_block_error:${rawPayload}`),
          element,
          order,
          value: {
            toolName: inferToolName(rawPayload),
            error: `Found <tool_call> markup but could not parse its JSON: ${(error as Error).message}`
          }
        });
      }
    }

    for (const match of text.matchAll(LABELED_TOOL_RE)) {
      const toolName = match[1];
      const argsPayload = match[2];
      try {
        const call = {
          name: toolName,
          arguments: parseArgumentsPayload(argsPayload)
        } satisfies ToolCall;
        candidates.push({
          baseId: toolCallIdentity(call),
          element,
          order,
          value: {call}
        });
      } catch (error) {
        candidates.push({
          baseId: hash(`labeled_tool_error:${toolName}\n${argsPayload}`),
          element,
          order,
          value: {
            toolName,
            error: `Found "Call Tool" output for ${toolName} but could not parse Arguments JSON: ${(error as Error).message}`
          }
        });
      }
    }
  }

  const latestCandidate = latestSourcedCandidate(candidates);
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
    clearActiveTool(callId);
    await updateStatus(
      'waiting',
      `Reported the ${phase} failure for ${tool} (${callId}) to ${chatProviderName()}. Waiting for a corrected call.`
    );
  } catch (deliveryError) {
    if (!stillRunning()) return;
    clearActiveTool(callId);
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
      activeTool = {
        name: job.tool,
        callId: job.tool_call_id,
        command: job.command || '> run_command [resumed background job]'
      };
      renderActiveTool();

      let result: Record<string, unknown>;
      try {
        result = await pollShellJob(job.tool_call_id, String(token));
      } catch (error) {
        if (!agentRunning) return;
        const message = (error as Error).message;
        removePendingShellJob(job.tool_call_id);
        clearActiveTool(job.tool_call_id);
        await returnFailureToAI(job.tool, 'execution', message, job.tool_call_id);
        continue;
      }

      if (!agentRunning) return;
      try {
        await feed({tool: job.tool, ...result});
        removePendingShellJob(job.tool_call_id);
        if (!agentRunning) return;
        clearActiveTool(job.tool_call_id);
        refreshVisibleHistory();
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
  if (!agentRunning || providerResponseIsGenerating() || activeBridgeCompletion || bridgeResponseSuppressionActive) return;
  const generation = agentRunGeneration;
  const stillRunning = () => agentRunning && generation === agentRunGeneration;
  const candidates = findToolCandidates();
  if (!candidates.length) return;

  for (const candidate of candidates) {
    if (!stillRunning()) return;
    const {id} = candidate;
    if (handled.has(id)) continue;
    handled.add(id);
    if (candidate.source === 'stream') streamedDomSuppressions.add(candidate.baseId);
    streamedProviderCalls.delete(id);
    const callId = createToolCallId();

    if (candidate.error) {
      toolCallCount += 1;
      setActiveTool({name: candidate.toolName || 'unknown'}, callId);
      await updateStatus('error', `${candidate.error} Tool call ID: ${callId}.`);
      if (!stillRunning()) return;
      await returnFailureToAI(candidate.toolName || 'unknown', 'parse', candidate.error, callId);
      continue;
    }

    const call = candidate.call;
    if (!call) continue;

    toolCallCount += 1;
    setActiveTool(call, callId);
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
      clearActiveTool(callId);
      refreshVisibleHistory();
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
  if (!agentRunning || providerResponseIsGenerating() || activeBridgeCompletion || bridgeResponseSuppressionActive || scanQueued) return;
  scanQueued = true;
  window.setTimeout(() => {
    scanQueued = false;
    if (agentRunning && !providerResponseIsGenerating() && !activeBridgeCompletion && !bridgeResponseSuppressionActive) void scan();
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
        closeCompletionBridge();
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
        void openCompletionBridge();
        queueScan();
      } else if (agentRunning && changes.token) {
        closeCompletionBridge();
        void openCompletionBridge();
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
  installProviderStreamBridge();
  installConnectionStorageSync();

  new MutationObserver(() => queueScan()).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true
  });

  if (agentRunning) {
    await updateStatus('waiting', `Connected to ${projectName(String(activeWorkspace))}. Waiting for a local tool call.`);
    void resumePendingShellJobs();
    void openCompletionBridge();
    queueScan();
  } else {
    const message = connection.token && activeWorkspace
      ? 'Stopped on this tab. Connect to resume local tools.'
      : 'Not connected. Save a token and project in the popup, then connect here.';
    await updateStatus('stopped', message);
  }
}

void init();
