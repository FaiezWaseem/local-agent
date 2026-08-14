type AgentStatus = {
  state: string;
  message: string;
  url?: string;
  ts?: number;
};

type ApprovalPolicy = {
  edits: boolean;
  deletes: boolean;
  shell: boolean;
};

type ApprovalSettings = {
  scope: 'project' | 'global';
  global: ApprovalPolicy;
  projects: Record<string, ApprovalPolicy>;
};

type StatusTone = 'neutral' | 'busy' | 'success' | 'error';

const CHAT_PROVIDERS: Record<string, string> = {
  'chat.deepseek.com': 'DeepSeek',
  'chat.qwen.ai': 'Qwen',
  'chat.z.ai': 'Z.ai'
};
const DEFAULT_RESULT_DELAY_MS = 5000;
const EMPTY_POLICY: ApprovalPolicy = {edits: false, deletes: false, shell: false};
const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;

const statusEl = $('#s');
const statusCardEl = $('#statusCard');
const connectionBadgeEl = $('#connectionBadge');
const settingsCardEl = $('#settingsCard');
const scopeNoteEl = $('#scopeNote');
const tokenEl = $('#token') as HTMLInputElement;
const workspaceEl = $('#workspace') as HTMLInputElement;
const saveEl = $('#save') as HTMLButtonElement;
const scopeProjectEl = $('#scopeProject') as HTMLInputElement;
const scopeGlobalEl = $('#scopeGlobal') as HTMLInputElement;
const approveEditsEl = $('#approveEdits') as HTMLInputElement;
const approveDeletesEl = $('#approveDeletes') as HTMLInputElement;
const approveShellEl = $('#approveShell') as HTMLInputElement;
const resultDelayEl = $('#resultDelay') as HTMLSelectElement;

let connectedWorkspace = '';
let approvalSettings: ApprovalSettings = {
  scope: 'project',
  global: {...EMPTY_POLICY},
  projects: {}
};

function providerForUrl(url?: string) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const name = CHAT_PROVIDERS[parsed.hostname];
    return name ? {name, url: parsed} : undefined;
  } catch {
    return undefined;
  }
}

function policyFrom(value: unknown): ApprovalPolicy {
  const candidate = value as Partial<ApprovalPolicy> | undefined;
  return {
    edits: candidate?.edits === true,
    deletes: candidate?.deletes === true,
    shell: candidate?.shell === true
  };
}

function settingsFrom(value: unknown): ApprovalSettings {
  const candidate = value as Partial<ApprovalSettings> | undefined;
  const projects: Record<string, ApprovalPolicy> = {};

  for (const [workspace, policy] of Object.entries(candidate?.projects || {})) {
    projects[workspace] = policyFrom(policy);
  }

  return {
    scope: candidate?.scope === 'global' ? 'global' : 'project',
    global: policyFrom(candidate?.global),
    projects
  };
}

function setStatus(text: string, tone: StatusTone = 'neutral') {
  statusEl.textContent = text;
  statusCardEl.dataset.state = tone;
}

function setConnected(connected: boolean) {
  connectionBadgeEl.dataset.state = connected ? 'connected' : 'offline';
  connectionBadgeEl.textContent = connected ? 'Connected' : 'Offline';
  settingsCardEl.dataset.locked = String(!connected);
}

function formatAgentStatus(agentStatus?: AgentStatus) {
  if (!agentStatus) {
    return 'No content-script heartbeat yet. Open a supported chat and attach the tab.';
  }

  const provider = providerForUrl(agentStatus.url)?.name;
  const lines = [`${provider ? `${provider} tab` : 'Tab'}: ${agentStatus.state}`];
  if (agentStatus.message) lines.push(agentStatus.message);
  if (agentStatus.ts) lines.push(`Updated ${new Date(agentStatus.ts).toLocaleTimeString()}`);
  return lines.join('\n');
}

function statusTone(agentStatus?: AgentStatus): StatusTone {
  if (agentStatus?.state === 'error') return 'error';
  if (['detected', 'approval', 'executing', 'cooldown', 'sending'].includes(agentStatus?.state || '')) return 'busy';
  if (agentStatus?.state === 'stopped') return 'neutral';
  if (agentStatus) return 'success';
  return 'neutral';
}

function projectName(workspace: string) {
  const trimmed = workspace.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).at(-1) || workspace;
}

function activePolicy() {
  if (approvalSettings.scope === 'global') {
    return approvalSettings.global;
  }
  return approvalSettings.projects[connectedWorkspace] || EMPTY_POLICY;
}

function renderApprovalSettings() {
  const isGlobal = approvalSettings.scope === 'global';
  scopeProjectEl.checked = !isGlobal;
  scopeGlobalEl.checked = isGlobal;

  const policy = activePolicy();
  approveEditsEl.checked = policy.edits;
  approveDeletesEl.checked = policy.deletes;
  approveShellEl.checked = policy.shell;

  scopeNoteEl.textContent = isGlobal
    ? 'These choices apply to every project connected from this browser.'
    : `These choices apply only to ${projectName(connectedWorkspace) || 'the connected project'}.`;
}

async function loadStoredValues() {
  const values = await chrome.storage.local.get([
    'token',
    'workspace',
    'connectedWorkspace',
    'agentStatus',
    'approvalSettings',
    'resultDelayMs'
  ]);

  tokenEl.value = values.token || '';
  workspaceEl.value = values.workspace || '';
  connectedWorkspace = values.connectedWorkspace || '';
  approvalSettings = settingsFrom(values.approvalSettings);
  const storedDelay = Number(values.resultDelayMs);
  resultDelayEl.value = String(Number.isFinite(storedDelay) && storedDelay >= 3000
    ? storedDelay
    : DEFAULT_RESULT_DELAY_MS);

  setConnected(Boolean(connectedWorkspace));
  renderApprovalSettings();

  const agentStatus = values.agentStatus as AgentStatus | undefined;
  setStatus(formatAgentStatus(agentStatus), statusTone(agentStatus));
}

async function readJson(response: Response) {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Request failed with status ${response.status}`);
  }
  return body;
}

async function call(url: string, body?: unknown) {
  const token = tokenEl.value.trim();
  const response = await fetch('http://127.0.0.1:43121' + url, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return readJson(response);
}

async function attachToActiveTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tab?.id) {
    throw new Error('Open DeepSeek, Qwen, or Z.ai in this window first.');
  }
  const provider = providerForUrl(tab.url);
  if (!provider) {
    throw new Error('The active tab is not a supported AI chat.');
  }

  await chrome.scripting.executeScript({
    target: {tabId: tab.id},
    files: ['content.js']
  });

  await new Promise(resolve => setTimeout(resolve, 150));
  const {agentStatus} = await chrome.storage.local.get('agentStatus');
  return agentStatus as AgentStatus | undefined;
}

async function persistApprovalSettings(message: string) {
  await chrome.storage.local.set({approvalSettings});
  setStatus(message, 'success');
}

async function changeApprovalScope(scope: 'project' | 'global') {
  approvalSettings = {...approvalSettings, scope};
  renderApprovalSettings();
  await persistApprovalSettings(
    scope === 'global'
      ? 'Approval scope changed to all projects.'
      : `Approval scope changed to ${projectName(connectedWorkspace)}.`
  );
}

async function updateActivePolicy(patch: Partial<ApprovalPolicy>) {
  if (approvalSettings.scope === 'global') {
    approvalSettings = {
      ...approvalSettings,
      global: {...approvalSettings.global, ...patch}
    };
  } else {
    const current = approvalSettings.projects[connectedWorkspace] || EMPTY_POLICY;
    approvalSettings = {
      ...approvalSettings,
      projects: {
        ...approvalSettings.projects,
        [connectedWorkspace]: {...current, ...patch}
      }
    };
  }

  renderApprovalSettings();
  const target = approvalSettings.scope === 'global'
    ? 'all projects'
    : projectName(connectedWorkspace);
  await persistApprovalSettings(`Approval settings saved for ${target}.`);
}

saveEl.addEventListener('click', async () => {
  const idleLabel = saveEl.textContent || 'Connect';
  try {
    const token = tokenEl.value.trim();
    const workspace = workspaceEl.value.trim();
    if (!token || !workspace) {
      throw new Error('Enter both the pairing token and project path.');
    }

    saveEl.disabled = true;
    saveEl.textContent = 'Connecting...';
    setStatus('Connecting to the local daemon...', 'busy');

    const connectResponse = await fetch('http://127.0.0.1:43121/connect', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({token})
    });
    const connect = await readJson(connectResponse);
    if (!connect.ok) {
      throw new Error(connect.error || 'Connection failed.');
    }

    const workspaceResult = await call('/workspace', {path: workspace});
    if (!workspaceResult.ok) {
      throw new Error(workspaceResult.error || 'Workspace setup failed.');
    }

    connectedWorkspace = workspaceResult.workspace;
    workspaceEl.value = connectedWorkspace;
    await chrome.storage.local.set({
      token,
      workspace: connectedWorkspace,
      connectedWorkspace
    });
    setConnected(true);
    renderApprovalSettings();

    let message = `Connected to ${projectName(connectedWorkspace)}.`;
    try {
      const agentStatus = await attachToActiveTab();
      message += `\n${formatAgentStatus(agentStatus)}`;
    } catch (error) {
      message += `\nTab: ${(error as Error).message}`;
    }

    setStatus(message, 'success');
  } catch (error) {
    connectedWorkspace = '';
    await chrome.storage.local.remove('connectedWorkspace');
    setConnected(false);
    renderApprovalSettings();
    setStatus((error as Error).message, 'error');
  } finally {
    saveEl.disabled = false;
    saveEl.textContent = idleLabel;
  }
});

$('#attach').addEventListener('click', async () => {
  try {
    setStatus('Attaching to the active AI chat tab...', 'busy');
    const agentStatus = await attachToActiveTab();
    setStatus(formatAgentStatus(agentStatus), statusTone(agentStatus));
  } catch (error) {
    setStatus((error as Error).message, 'error');
  }
});

$('#health').addEventListener('click', async () => {
  try {
    setStatus('Checking daemon and tab...', 'busy');
    const healthResponse = await fetch('http://127.0.0.1:43121/health');
    const health = await readJson(healthResponse);
    const {agentStatus} = await chrome.storage.local.get('agentStatus');
    setStatus(
      `Daemon ready: ${projectName(health.workspace)}\n${formatAgentStatus(agentStatus as AgentStatus | undefined)}`,
      'success'
    );
  } catch (error) {
    setStatus(`Daemon not reachable: ${(error as Error).message}`, 'error');
  }
});

scopeProjectEl.addEventListener('change', () => {
  if (scopeProjectEl.checked) void changeApprovalScope('project');
});

scopeGlobalEl.addEventListener('change', () => {
  if (scopeGlobalEl.checked) void changeApprovalScope('global');
});

approveEditsEl.addEventListener('change', () => {
  void updateActivePolicy({edits: approveEditsEl.checked});
});

approveDeletesEl.addEventListener('change', () => {
  void updateActivePolicy({deletes: approveDeletesEl.checked});
});

approveShellEl.addEventListener('change', () => {
  void updateActivePolicy({shell: approveShellEl.checked});
});

resultDelayEl.addEventListener('change', async () => {
  const resultDelayMs = Number(resultDelayEl.value) || DEFAULT_RESULT_DELAY_MS;
  await chrome.storage.local.set({resultDelayMs});
  setStatus(`Automatic tool results will wait ${resultDelayMs / 1000} seconds.`, 'success');
});

chrome.storage.onChanged.addListener(changes => {
  const agentStatus = changes.agentStatus?.newValue as AgentStatus | undefined;
  if (agentStatus) {
    setStatus(formatAgentStatus(agentStatus), statusTone(agentStatus));
  }
});

void loadStoredValues();
