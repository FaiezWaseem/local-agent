type BridgeWindow = Window & {
  __localAiAgentChatGptStreamInstalled?: boolean;
};

type ChatGptAuthor = {
  role?: string;
};

type ChatGptContent = {
  content_type?: string;
  parts?: unknown[];
};

type ChatGptMessage = {
  author?: ChatGptAuthor;
  content?: ChatGptContent;
  status?: string;
};

type ChatGptPayload = {
  message?: ChatGptMessage;
  p?: string;
  o?: string;
  v?: unknown;
};

type StreamState = {
  answer: string;
  dispatched: boolean;
};

type StreamUpdate = {
  finished: boolean;
  delta: string;
};

const STREAM_EVENT = 'local-ai-agent:chatgpt-answer';
const STREAM_STATE_EVENT = 'local-ai-agent:provider-stream-state';
const STREAM_DELTA_EVENT = 'local-ai-agent:provider-stream-delta';
const CONVERSATION_PATH = /\/backend-(?:api|anon)(?:\/f)?\/conversation\/?$/;
const TEXT_PATH = /(?:^|\/)message\/content\/parts(?:\/0)?$/;
const STATUS_PATH = /(?:^|\/)message\/status$/;
const FINISHED = /^(?:finished_successfully|finished)$/;
const bridgeWindow = window as BridgeWindow;

function isConversationUrl(value: string) {
  try {
    return CONVERSATION_PATH.test(new URL(value, location.href).pathname);
  } catch {
    return false;
  }
}

function createStreamState(): StreamState {
  return {answer: '', dispatched: false};
}

function assistantText(message: ChatGptMessage | undefined) {
  if (!message) return null;
  if (message.author?.role && message.author.role !== 'assistant') return null;
  const content = message.content;
  if (!content) return null;
  if (content.content_type && content.content_type !== 'text') return null;
  if (!Array.isArray(content.parts)) return null;
  return content.parts.filter(part => typeof part === 'string').join('');
}

function appendedText(previous: string, next: string) {
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

function messageFromValue(value: unknown): ChatGptMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if ('message' in value) return (value as ChatGptPayload).message;
  if ('content' in value || 'author' in value) return value as ChatGptMessage;
  return undefined;
}

function applyPayload(state: StreamState, payload: unknown): StreamUpdate {
  if (payload == null || payload === '[DONE]') {
    return {delta: '', finished: payload === '[DONE]'};
  }

  if (typeof payload !== 'object') return {finished: false, delta: ''};

  const record = payload as ChatGptPayload;
  const snapshot = assistantText(record.message) ?? assistantText(messageFromValue(record.v));
  if (snapshot != null) {
    const delta = appendedText(state.answer, snapshot);
    state.answer = snapshot;
    const status = record.message?.status || messageFromValue(record.v)?.status;
    return {delta, finished: Boolean(status && FINISHED.test(status))};
  }

  const path = typeof record.p === 'string' ? record.p : '';
  const operation = typeof record.o === 'string' ? record.o.toLowerCase() : '';
  const value = record.v;

  if (STATUS_PATH.test(path) && typeof value === 'string' && FINISHED.test(value)) {
    return {delta: '', finished: true};
  }

  if (operation === 'patch' && Array.isArray(value)) {
    let delta = '';
    let finished = false;
    for (const item of value) {
      const update = applyPayload(state, item);
      delta += update.delta;
      finished = finished || update.finished;
    }
    return {delta, finished};
  }

  if (typeof value !== 'string') return {finished: false, delta: ''};
  if (path && !TEXT_PATH.test(path)) return {finished: false, delta: ''};

  if (operation === 'replace' || operation === 'set') {
    const delta = appendedText(state.answer, value);
    state.answer = value;
    return {delta, finished: false};
  }

  state.answer += value;
  return {delta: value, finished: false};
}

function applyData(state: StreamState, data: string): StreamUpdate {
  const value = data.trim();
  if (!value || value === '[DONE]') return {finished: value === '[DONE]', delta: ''};

  try {
    return applyPayload(state, JSON.parse(value) as ChatGptPayload);
  } catch {
    return {finished: false, delta: ''};
  }
}

function applyEvent(state: StreamState, event: string): StreamUpdate {
  const data = event
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
  return data ? applyData(state, data) : {finished: false, delta: ''};
}

function answerFromEventStream(body: string) {
  const state = createStreamState();
  for (const event of body.split(/\r?\n\r?\n/)) applyEvent(state, event);
  return state.answer.trim();
}

function dispatchAnswer(state: StreamState) {
  if (state.dispatched) return;
  const answer = state.answer.trim();
  if (!answer) return;

  state.dispatched = true;
  document.dispatchEvent(new CustomEvent(STREAM_EVENT, {detail: answer}));
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
  const state = createStreamState();
  const reader = response.body?.getReader();
  if (!reader) {
    state.answer = answerFromEventStream(await response.text());
    dispatchDelta(state.answer);
    dispatchAnswer(state);
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const {done, value} = await reader.read();
    buffer += decoder.decode(value, {stream: !done});
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || '';

    for (const event of events) {
      const update = applyEvent(state, event);
      dispatchDelta(update.delta);
      if (update.finished) {
        dispatchAnswer(state);
        void reader.cancel().catch(() => undefined);
        return;
      }
    }

    if (done) break;
  }

  if (buffer.trim()) {
    const update = applyEvent(state, buffer);
    dispatchDelta(update.delta);
  }
  dispatchAnswer(state);
}

function observeResponse(response: Response) {
  if (!response.ok) return false;

  try {
    void observeEventStream(response.clone())
      .catch(() => undefined)
      .finally(() => dispatchStreamState('finished'));
    return true;
  } catch {
    return false;
  }
}

if (!bridgeWindow.__localAiAgentChatGptStreamInstalled) {
  bridgeWindow.__localAiAgentChatGptStreamInstalled = true;
  const nativeFetch = window.fetch;

  window.fetch = (async (...args: Parameters<typeof fetch>) => {
    const watched = isConversationUrl(requestUrl(args[0]));
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
      if (isConversationUrl(String(args[1]))) watchedRequests.add(this);
      return Reflect.apply(nativeOpen, this, args) as void;
    } as typeof nativeOpen;

    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: Parameters<typeof nativeSend>) {
      if (watchedRequests.has(this)) {
        dispatchStreamState('started');
        this.addEventListener('loadend', () => {
          try {
            if (this.status >= 200 && this.status < 300 && (!this.responseType || this.responseType === 'text')) {
              const state = createStreamState();
              state.answer = answerFromEventStream(this.responseText);
              dispatchDelta(state.answer);
              dispatchAnswer(state);
            }
          } catch {
            // Non-text XHR responses are left to the DOM scanner.
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
