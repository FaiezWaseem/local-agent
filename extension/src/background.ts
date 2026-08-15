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

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const candidate = message as Partial<DaemonRequestMessage> | undefined;
  if (candidate?.type !== 'daemon-request' || typeof candidate.path !== 'string') return undefined;

  void handleDaemonRequest(candidate as DaemonRequestMessage).then(sendResponse);
  return true;
});
