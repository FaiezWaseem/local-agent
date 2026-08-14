type BridgeWindow = Window & {
  __localAiAgentDeepSeekStreamInstalled?: boolean;
};

type DeepSeekFragment = {
  type?: string;
  content?: string;
};

type DeepSeekResponse = {
  status?: string;
  quasi_status?: string;
  fragments?: DeepSeekFragment[];
};

type DeepSeekPatch = {
  p?: string;
  o?: string;
  v?: unknown;
};

type StreamState = {
  answer: string;
  lastPath: string;
  lastOperation: string;
  dispatched: boolean;
};

type StreamUpdate = {
  finished: boolean;
  delta: string;
};

const STREAM_EVENT = 'local-ai-agent:deepseek-answer';
const STREAM_STATE_EVENT = 'local-ai-agent:provider-stream-state';
const STREAM_DELTA_EVENT = 'local-ai-agent:provider-stream-delta';
const CHAT_COMPLETION_PATH = '/api/v0/chat/completion';
const bridgeWindow = window as BridgeWindow;

function isChatCompletionUrl(value: string) {
  try {
    return new URL(value, location.href).pathname === CHAT_COMPLETION_PATH;
  } catch {
    return false;
  }
}

function createStreamState(): StreamState {
  return {answer: '', lastPath: '', lastOperation: '', dispatched: false};
}

function responseText(response: DeepSeekResponse) {
  return (response.fragments || [])
    .filter(fragment => fragment.type === 'RESPONSE' && typeof fragment.content === 'string')
    .map(fragment => fragment.content)
    .join('');
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

function appendedText(previous: string, next: string) {
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

function applyPatch(state: StreamState, patch: DeepSeekPatch): StreamUpdate {
  const snapshot = patch.v && typeof patch.v === 'object'
    ? (patch.v as {response?: DeepSeekResponse}).response
    : undefined;
  if (snapshot) {
    const next = responseText(snapshot);
    const delta = appendedText(state.answer, next);
    state.answer = next;
    return {
      delta,
      finished: snapshot.status === 'FINISHED' || snapshot.quasi_status === 'FINISHED'
    };
  }

  if (typeof patch.p === 'string') state.lastPath = patch.p;
  if (typeof patch.o === 'string') state.lastOperation = patch.o;
  const path = patch.p || state.lastPath;
  const operation = patch.o || state.lastOperation;
  let delta = '';

  if (path === 'response/fragments/-1/content' && typeof patch.v === 'string') {
    if (operation === 'SET') {
      delta = appendedText(state.answer, patch.v);
      state.answer = patch.v;
    } else {
      delta = patch.v;
      state.answer += patch.v;
    }
  } else if (/^response\/fragments(?:\/-1|\/\d+)?$/.test(path) && patch.v && typeof patch.v === 'object') {
    const fragment = patch.v as DeepSeekFragment;
    if (fragment.type === 'RESPONSE' && typeof fragment.content === 'string') {
      if (operation === 'SET') {
        delta = appendedText(state.answer, fragment.content);
        state.answer = fragment.content;
      } else {
        delta = fragment.content;
        state.answer += fragment.content;
      }
    }
  }

  return {delta, finished: path === 'response/status' && patch.v === 'FINISHED'};
}

function applyData(state: StreamState, data: string): StreamUpdate {
  const value = data.trim();
  if (!value || value === '[DONE]') return {finished: value === '[DONE]', delta: ''};

  try {
    return applyPatch(state, JSON.parse(value) as DeepSeekPatch);
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
    // A locked or opaque response cannot be cloned; the DOM scanner remains available.
    return false;
  }
}

if (!bridgeWindow.__localAiAgentDeepSeekStreamInstalled) {
  bridgeWindow.__localAiAgentDeepSeekStreamInstalled = true;
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
              const state = createStreamState();
              state.answer = answerFromEventStream(this.responseText);
              dispatchDelta(state.answer);
              dispatchAnswer(state);
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
