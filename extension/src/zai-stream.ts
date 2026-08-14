type BridgeWindow = Window & {
  __localAiAgentZaiStreamInstalled?: boolean;
};

type ZaiChunk = {
  type?: string;
  data?: {
    phase?: string;
    delta_content?: string;
  };
};

const STREAM_EVENT = 'local-ai-agent:zai-answer';
const CHAT_COMPLETIONS_PATH = '/api/v2/chat/completions';
const bridgeWindow = window as BridgeWindow;

function isChatCompletionUrl(value: string) {
  try {
    return new URL(value, location.href).pathname === CHAT_COMPLETIONS_PATH;
  } catch {
    return false;
  }
}

function answerFromEventStream(body: string) {
  let answer = '';

  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;

    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    try {
      const chunk = JSON.parse(payload) as ZaiChunk;
      const data = chunk.type === 'chat:completion' ? chunk.data : undefined;
      if (data?.phase === 'answer' && typeof data.delta_content === 'string') {
        answer += data.delta_content;
      }
    } catch {
      // Ignore keep-alives and non-JSON SSE lines.
    }
  }

  return answer.trim();
}

function dispatchAnswer(body: string) {
  const answer = answerFromEventStream(body);
  if (answer) {
    document.dispatchEvent(new CustomEvent(STREAM_EVENT, {detail: answer}));
  }
}

function observeResponse(response: Response) {
  if (!response.ok || !isChatCompletionUrl(response.url)) return;

  try {
    const copy = response.clone();
    void copy.text().then(dispatchAnswer).catch(() => undefined);
  } catch {
    // A locked or opaque response cannot be cloned; the DOM scanner remains available.
  }
}

if (!bridgeWindow.__localAiAgentZaiStreamInstalled) {
  bridgeWindow.__localAiAgentZaiStreamInstalled = true;
  const nativeFetch = window.fetch;

  window.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await nativeFetch(...args);
    observeResponse(response);
    return response;
  }) as typeof fetch;

  if ('XMLHttpRequest' in window) {
    const watchedRequests = new WeakSet<XMLHttpRequest>();
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (...args: Parameters<typeof nativeOpen>) {
      if (isChatCompletionUrl(String(args[1]))) watchedRequests.add(this);
      return Reflect.apply(nativeOpen, this, args) as void;
    } as typeof nativeOpen;

    XMLHttpRequest.prototype.send = function (...args: Parameters<typeof nativeSend>) {
      if (watchedRequests.has(this)) {
        this.addEventListener('loadend', () => {
          try {
            if (this.status >= 200 && this.status < 300 && (!this.responseType || this.responseType === 'text')) {
              dispatchAnswer(this.responseText);
            }
          } catch {
            // Cross-origin or non-text XHR responses are left to the DOM scanner.
          }
        }, {once: true});
      }

      return Reflect.apply(nativeSend, this, args) as void;
    } as typeof nativeSend;
  }
}
