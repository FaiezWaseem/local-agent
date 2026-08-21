type DaemonRequestMessage = {
  type: 'daemon-request';
  path: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
};

type DaemonResponseMessage = {
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
};

const DAEMON_BASE_URL = 'http://127.0.0.1:43121';
const STREAM_SCRIPTS: Record<string, string> = {
  'chatgpt.com': 'chatgpt-stream.js',
  'www.chatgpt.com': 'chatgpt-stream.js',
  'chat.openai.com': 'chatgpt-stream.js',
  'chat.deepseek.com': 'deepseek-stream.js',
  'chat.z.ai': 'zai-stream.js'
};
const CHAT_TAB_URLS = [
  'https://chatgpt.com/*',
  'https://*.chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://chat.deepseek.com/*',
  'https://chat.qwen.ai/*',
  'https://chat.z.ai/*'
];

function isChatTabUrl(url?: string) {
  if (!url) return false;
  try {
    const {hostname} = new URL(url);
    return Boolean(STREAM_SCRIPTS[hostname] || hostname === 'chat.qwen.ai' || hostname.endsWith('.chatgpt.com'));
  } catch {
    return false;
  }
}

async function handleDaemonRequest(message: DaemonRequestMessage): Promise<DaemonResponseMessage> {
  try {
    const response = await fetch(DAEMON_BASE_URL + message.path, {
      method: message.method || 'GET',
      headers: message.headers,
      body: message.body == null ? undefined : JSON.stringify(message.body)
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }

    return {
      ok: response.ok,
      status: response.status,
      body,
      error: response.ok ? undefined : String((body as {error?: unknown} | undefined)?.error || `Daemon returned status ${response.status}.`)
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function ensureTabBridge(tabId: number, url?: string) {
  try {
    await chrome.tabs.sendMessage(tabId, {type: 'ensure-bridge'});
    return;
  } catch {
    // Content script is missing; inject it.
  }

  const hostname = url ? new URL(url).hostname : '';
  const streamFile = STREAM_SCRIPTS[hostname];
  if (streamFile) {
    await chrome.scripting.executeScript({
      target: {tabId},
      files: [streamFile],
      world: 'MAIN'
    }).catch(() => undefined);
  }
  await chrome.scripting.executeScript({
    target: {tabId},
    files: ['content.js']
  }).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const candidate = message as Partial<DaemonRequestMessage> | undefined;
  if (candidate?.type !== 'daemon-request' || typeof candidate.path !== 'string') return undefined;

  void handleDaemonRequest(candidate as DaemonRequestMessage).then(sendResponse);
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !isChatTabUrl(tab.url)) return;
  void ensureTabBridge(tabId, tab.url);
});

chrome.alarms.create('ensure-bridge', {periodInMinutes: 1});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'ensure-bridge') return;
  void chrome.tabs.query({url: CHAT_TAB_URLS}).then(async tabs => {
    for (const tab of tabs) {
      if (tab.id) await ensureTabBridge(tab.id, tab.url);
    }
  });
});
