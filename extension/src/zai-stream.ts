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
const STREAM_STATE_EVENT = 'local-ai-agent:provider-stream-state';
const STREAM_DELTA_EVENT = 'local-ai-agent:provider-stream-delta';
const CHAT_COMPLETIONS_PATH = '/api/v2/chat/completions';
const bridgeWindow = window as BridgeWindow;

function isChatCompletionUrl(value: string) {
  try {
    return new URL(value, location.href).pathname === CHAT_COMPLETIONS_PATH;
  } catch {
    return false;
  }
}

function eventDelta(event: string) {
  const payload = event
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (!payload || payload === '[DONE]') return '';

  try {
    const chunk = JSON.parse(payload) as ZaiChunk;
    const data = chunk.type === 'chat:completion' ? chunk.data : undefined;
    return data?.phase === 'answer' && typeof data.delta_content === 'string'
      ? data.delta_content
      : '';
  } catch {
    return '';
  }
}

function answerFromEventStream(body: string) {
  return body.split(/\r?\n\r?\n/).map(eventDelta).join('');
}

function dispatchAnswer(answer: string) {
  if (answer.trim()) document.dispatchEvent(new CustomEvent(STREAM_EVENT, {detail: answer}));
}

function dispatchStreamState(state: 'started' | 'finished') {
  document.dispatchEvent(new CustomEvent(STREAM_STATE_EVENT, {detail: state}));
}

function dispatchDelta(delta: string) {
  if (delta) document.dispatchEvent(new CustomEvent(STREAM_DELTA_EVENT, {detail: delta}));
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

async function observeEventStream(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) {
    const answer = answerFromEventStream(await response.text());
    dispatchDelta(answer);
    dispatchAnswer(answer);
    return;
  }

  const decoder = new TextDecoder();
  let answer = '';
  let buffer = '';

  while (true) {
    const {done, value} = await reader.read();
    buffer += decoder.decode(value, {stream: !done});
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';
    for (const event of events) {
      const delta = eventDelta(event);
      answer += delta;
      dispatchDelta(delta);
    }
    if (done) break;
  }

  if (buffer.trim()) {
    const delta = eventDelta(buffer);
    answer += delta;
    dispatchDelta(delta);
  }
  dispatchAnswer(answer);
}

function observeResponse(response: Response) {
  if (!response.ok) return false;

  try {
    void observeEventStream(response.clone())
      .catch(() => undefined)
      .finally(() => dispatchStreamState('finished'));
    return true;
  } catch {
    // A locked or opaque response cannot be cloned; the DOM scanner remains available.
    return false;
  }
}

if (!bridgeWindow.__localAiAgentZaiStreamInstalled) {
  bridgeWindow.__localAiAgentZaiStreamInstalled = true;
  const nativeFetch = window.fetch;

  window.fetch = (async (...args: Parameters<typeof fetch>) => {
    const watched = isChatCompletionUrl(requestUrl(args[0]));
    if (watched) dispatchStreamState('started');

    try {
      const response = await nativeFetch(...args);
      if (watched && !observeResponse(response)) dispatchStreamState('finished');
      return response;
    } catch (error) {
      if (watched) dispatchStreamState('finished');
      throw error;
    }
  }) as typeof fetch;

  if ('XMLHttpRequest' in window) {
    const watchedRequests = new WeakSet<XMLHttpRequest>();
    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: Parameters<typeof nativeOpen>) {
      if (isChatCompletionUrl(String(args[1]))) watchedRequests.add(this);
      return Reflect.apply(nativeOpen, this, args) as void;
    } as typeof nativeOpen;

    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: Parameters<typeof nativeSend>) {
      if (watchedRequests.has(this)) {
        dispatchStreamState('started');
        this.addEventListener('loadend', () => {
          try {
            if (this.status >= 200 && this.status < 300 && (!this.responseType || this.responseType === 'text')) {
              const answer = answerFromEventStream(this.responseText);
              dispatchDelta(answer);
              dispatchAnswer(answer);
            }
          } catch {
            // Cross-origin or non-text XHR responses are left to the DOM scanner.
          } finally {
            dispatchStreamState('finished');
          }
        }, {once: true});
      }

      try {
        return Reflect.apply(nativeSend, this, args) as void;
      } catch (error) {
        if (watchedRequests.has(this)) dispatchStreamState('finished');
        throw error;
      }
    } as typeof nativeSend;
  }
}
