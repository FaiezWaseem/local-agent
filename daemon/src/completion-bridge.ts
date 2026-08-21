import crypto from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {FastifyInstance} from 'fastify';
import WebSocket, {WebSocketServer, type RawData} from 'ws';
import {z} from 'zod';

type Provider = 'deepseek' | 'zai' | 'chatgpt';

type BridgeClient = {
  id: string;
  provider?: Provider;
  url?: string;
  busy: boolean;
  socket: WebSocket;
};

type EventSubscriber = {
  response: ServerResponse;
  includeContent: boolean;
};

type CompletionBody = z.infer<typeof completionBodySchema>;
type OpenAiToolCall = z.infer<typeof toolCallSchema>;

type PendingCompletion = {
  id: string;
  created: number;
  model: string;
  provider: Provider;
  client: BridgeClient;
  stream: boolean;
  content: string;
  lastSequence: number;
  settled: boolean;
  response?: ServerResponse;
  resolve?: (value: unknown) => void;
  reject?: (error: BridgeError) => void;
  timeout: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
};

type BridgeMessage = {
  type?: string;
  request_id?: string;
  client_id?: string;
  provider?: string;
  url?: string;
  sequence?: number;
  delta?: string;
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  finish_reason?: string;
  error?: string;
};

class BridgeError extends Error {
  constructor(message: string, readonly statusCode = 502, readonly code = 'bridge_error') {
    super(message);
  }
}

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string()
  }).passthrough()
}).passthrough();

const messageSchema = z.object({
  role: z.string().min(1),
  content: z.union([
    z.string(),
    z.array(z.object({type: z.string(), text: z.string().optional()}).passthrough())
  ]).nullable().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional()
}).passthrough();

const functionToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional()
  }).passthrough()
}).passthrough();

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required']),
  z.object({
    type: z.literal('function'),
    function: z.object({name: z.string().min(1)}).passthrough()
  }).passthrough()
]);

const completionBodySchema = z.object({
  model: z.string().min(1).default('deepseek-web'),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional().default(false),
  tools: z.array(functionToolSchema).max(128).optional().default([]),
  tool_choice: toolChoiceSchema.optional().default('auto'),
  parallel_tool_calls: z.boolean().optional().default(false)
}).passthrough();

const BRIDGE_PROTOCOL = 'local-ai-agent';
const COMPLETION_TIMEOUT_MS = Math.max(30_000, Number(process.env.COMPLETION_TIMEOUT_MS || 300_000));

function openAiError(message: string, code: string, type = 'invalid_request_error') {
  return {error: {message, type, code}};
}

function providerForModel(model: string): Provider | undefined {
  if (/deepseek/i.test(model)) return 'deepseek';
  if (/(?:^|[-_])(zai|z\.ai|glm)(?:$|[-_])/i.test(model) || /^(zai|z\.ai|glm)/i.test(model)) return 'zai';
  if (/chatgpt/i.test(model) || /(?:^|[-_])openai(?:-web)?$/i.test(model)) return 'chatgpt';
  if (model === 'auto' || model === 'web-auto') return undefined;
  return undefined;
}

function isSupportedModel(model: string) {
  return model === 'auto' || model === 'web-auto' || providerForModel(model) != null;
}

function normalizeProvider(value: string | undefined): Provider | undefined {
  if (value === 'deepseek' || value === 'zai' || value === 'chatgpt') return value;
  return undefined;
}

function protocolValues(req: IncomingMessage) {
  return String(req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function socketSend(socket: WebSocket, value: unknown) {
  if (socket.readyState !== WebSocket.OPEN) throw new BridgeError('Extension bridge disconnected.', 503, 'bridge_disconnected');
  socket.send(JSON.stringify(value));
}

function writeSse(response: ServerResponse, value: unknown) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function completionChunk(pending: PendingCompletion, delta: Record<string, unknown>, finishReason: string | null) {
  return {
    id: pending.id,
    object: 'chat.completion.chunk',
    created: pending.created,
    model: pending.model,
    choices: [{index: 0, delta, finish_reason: finishReason}]
  };
}

function completionResponse(
  pending: PendingCompletion,
  content: string,
  finishReason: string,
  toolCalls: OpenAiToolCall[]
) {
  const message = toolCalls.length
    ? {role: 'assistant', content: null, tool_calls: toolCalls}
    : {role: 'assistant', content};
  return {
    id: pending.id,
    object: 'chat.completion',
    created: pending.created,
    model: pending.model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason
    }],
    usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0}
  };
}

export function installCompletionBridge(app: FastifyInstance, token: string) {
  const clients = new Set<BridgeClient>();
  const pending = new Map<string, PendingCompletion>();
  const subscribers = new Set<EventSubscriber>();

  const clientSnapshot = (client: BridgeClient) => ({
    client_id: client.id,
    provider: client.provider || null,
    busy: client.busy,
    ready_state: client.socket.readyState,
    url: client.url || null
  });

  const matchingClients = (model: string) => {
    const requestedProvider = providerForModel(model);
    return [...clients].filter(client => (
      client.provider
      && (!requestedProvider || client.provider === requestedProvider)
    ));
  };

  const publish = (type: string, details: Record<string, unknown> = {}) => {
    const event: Record<string, unknown> = {type, ts: new Date().toISOString(), ...details};
    const {delta, content, ...safeEvent} = event;
    console.log(`[BRIDGE]->${type} ${JSON.stringify(safeEvent)}`);

    for (const subscriber of subscribers) {
      const body = subscriber.includeContent ? event : safeEvent;
      try {
        subscriber.response.write(`event: ${type}\ndata: ${JSON.stringify(body)}\n\n`);
      } catch {
        subscribers.delete(subscriber);
      }
    }
  };

  const release = (item: PendingCompletion) => {
    if (item.settled) return false;
    item.settled = true;
    clearTimeout(item.timeout);
    if (item.heartbeat) clearInterval(item.heartbeat);
    pending.delete(item.id);
    item.client.busy = false;
    publish('bridge.client.released', {
      request_id: item.id,
      ...clientSnapshot(item.client)
    });
    return true;
  };

  const fail = (item: PendingCompletion, error: BridgeError) => {
    if (!release(item)) return;
    publish('completion.error', {
      request_id: item.id,
      provider: item.provider,
      model: item.model,
      code: error.code,
      error: error.message
    });

    if (item.stream && item.response && !item.response.destroyed) {
      writeSse(item.response, openAiError(error.message, error.code, 'bridge_error'));
      item.response.write('data: [DONE]\n\n');
      item.response.end();
    } else {
      item.reject?.(error);
    }
  };

  const finish = (
    item: PendingCompletion,
    finalContent: string | null,
    finishReason: string,
    toolCalls: OpenAiToolCall[] = []
  ) => {
    if (item.settled) return;
    const content = finalContent || item.content;

    if (item.stream && item.response && !item.response.destroyed) {
      if (toolCalls.length) {
        writeSse(item.response, completionChunk(item, {
          tool_calls: toolCalls.map((call, index) => ({index, ...call}))
        }, null));
      } else if (content.startsWith(item.content) && content.length > item.content.length) {
        const remainder = content.slice(item.content.length);
        item.content = content;
        writeSse(item.response, completionChunk(item, {content: remainder}, null));
      }
      writeSse(item.response, completionChunk(item, {}, finishReason));
      item.response.write('data: [DONE]\n\n');
      item.response.end();
    } else {
      item.resolve?.(completionResponse(item, content, finishReason, toolCalls));
    }

    if (!release(item)) return;
    publish('completion.finished', {
      request_id: item.id,
      provider: item.provider,
      model: item.model,
      finish_reason: finishReason,
      tool_call_count: toolCalls.length,
      content_length: content.length
    });
  };

  const cancel = (item: PendingCompletion, reason: string) => {
    if (!release(item)) return;
    try {
      socketSend(item.client.socket, {type: 'completion.cancel', request_id: item.id});
    } catch {
      // The request is already released even if its browser tab disconnected.
    }
    publish('completion.cancelled', {
      request_id: item.id,
      provider: item.provider,
      model: item.model,
      reason
    });
  };

  const handleBridgeMessage = (client: BridgeClient, raw: RawData) => {
    let message: BridgeMessage;
    try {
      message = JSON.parse(raw.toString()) as BridgeMessage;
    } catch {
      socketSend(client.socket, {type: 'bridge.error', error: 'Invalid bridge JSON.'});
      return;
    }

    if (message.type === 'bridge.register') {
      const provider = normalizeProvider(message.provider);
      if (!provider || typeof message.client_id !== 'string' || !message.client_id.trim()) {
        socketSend(client.socket, {type: 'bridge.error', error: 'Registration requires client_id and a supported provider.'});
        return;
      }
      client.id = message.client_id.trim().slice(0, 120);
      client.provider = provider;
      client.url = String(message.url || '').slice(0, 1000);
      socketSend(client.socket, {type: 'bridge.ready', client_id: client.id, provider});
      publish('bridge.connected', {client_id: client.id, provider, url: client.url});
      publish('bridge.client.state', clientSnapshot(client));
      return;
    }

    if (message.type === 'bridge.ping') {
      socketSend(client.socket, {type: 'bridge.pong', ts: Date.now()});
      return;
    }

    const item = typeof message.request_id === 'string' ? pending.get(message.request_id) : undefined;
    if (!item || item.client !== client) return;

    if (message.type === 'completion.accepted') {
      publish('completion.accepted', {
        request_id: item.id,
        provider: item.provider,
        model: item.model
      });
      return;
    }

    if (message.type === 'completion.delta' && typeof message.delta === 'string') {
      const sequence = Number.isInteger(message.sequence) ? Number(message.sequence) : item.lastSequence + 1;
      if (sequence <= item.lastSequence) return;
      item.lastSequence = sequence;
      item.content += message.delta;
      if (item.stream && item.response && !item.response.destroyed) {
        writeSse(item.response, completionChunk(item, {content: message.delta}, null));
      }
      publish('completion.delta', {
        request_id: item.id,
        provider: item.provider,
        model: item.model,
        sequence,
        delta_length: message.delta.length,
        delta: message.delta
      });
      return;
    }

    if (message.type === 'completion.completed') {
      const parsedToolCalls = z.array(toolCallSchema).safeParse(message.tool_calls || []);
      if (!parsedToolCalls.success) {
        fail(item, new BridgeError('Extension returned invalid OpenAI tool calls.', 502, 'invalid_tool_calls'));
        return;
      }
      const toolCalls = parsedToolCalls.data;
      const finishReason = toolCalls.length ? 'tool_calls' : message.finish_reason || 'stop';
      finish(item, typeof message.content === 'string' ? message.content : null, finishReason, toolCalls);
      return;
    }

    if (message.type === 'completion.error') {
      fail(item, new BridgeError(message.error || 'Extension completion failed.'));
    }
  };

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      return protocols.has(BRIDGE_PROTOCOL) ? BRIDGE_PROTOCOL : false;
    }
  });

  app.server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws/extension') {
      socket.destroy();
      return;
    }

    const protocols = protocolValues(req);
    if (!protocols.includes(BRIDGE_PROTOCOL) || !protocols.includes(`token.${token}`)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', socket => {
    const client: BridgeClient = {id: crypto.randomUUID(), busy: false, socket};
    clients.add(client);
    publish('bridge.socket.open', clientSnapshot(client));

    socket.on('message', raw => handleBridgeMessage(client, raw));
    socket.on('close', () => {
      clients.delete(client);
      for (const item of [...pending.values()]) {
        if (item.client === client) fail(item, new BridgeError('Extension tab disconnected.', 503, 'bridge_disconnected'));
      }
      publish('bridge.socket.closed', clientSnapshot(client));
      if (client.provider) publish('bridge.disconnected', {client_id: client.id, provider: client.provider});
    });
  });

  const selectClient = (model: string) => {
    const matches = matchingClients(model);
    publish('bridge.select.inspect', {
      model,
      requested_provider: providerForModel(model) || 'auto',
      matching_clients: matches.map(clientSnapshot)
    });
    return matches.find(client => (
      !client.busy
      && client.socket.readyState === WebSocket.OPEN
    ));
  };

  const bridgeUnavailableReason = (model: string) => {
    const matches = matchingClients(model);
    if (!matches.length) {
      return {
        message: `No extension tab is connected for model ${model}.`,
        code: 'bridge_unavailable'
      };
    }
    if (matches.some(client => client.busy)) {
      return {
        message: `An extension tab is connected for model ${model}, but it is busy.`,
        code: 'bridge_busy'
      };
    }
    return {
      message: `An extension tab is connected for model ${model}, but its bridge is not open.`,
      code: 'bridge_disconnected'
    };
  };

  const startCompletion = (body: CompletionBody, client: BridgeClient, response?: ServerResponse) => {
    const provider = client.provider as Provider;
    const id = `chatcmpl_${crypto.randomUUID().replaceAll('-', '')}`;
    const created = Math.floor(Date.now() / 1000);
    let resolve: ((value: unknown) => void) | undefined;
    let reject: ((error: BridgeError) => void) | undefined;
    const promise = body.stream ? undefined : new Promise<unknown>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });

    const item: PendingCompletion = {
      id,
      created,
      model: body.model,
      provider,
      client,
      stream: body.stream,
      content: '',
      lastSequence: -1,
      settled: false,
      response,
      resolve,
      reject,
      timeout: setTimeout(() => {
        try {
          socketSend(client.socket, {type: 'completion.cancel', request_id: id});
        } catch {
          // The timeout response remains authoritative if the tab already disconnected.
        }
        fail(item, new BridgeError('Completion timed out waiting for the extension.', 504, 'completion_timeout'));
      }, COMPLETION_TIMEOUT_MS)
    };

    client.busy = true;
    publish('bridge.client.busy', {
      request_id: id,
      ...clientSnapshot(client)
    });
    pending.set(id, item);
    publish('completion.queued', {request_id: id, provider, model: body.model, stream: body.stream});
    try {
      socketSend(client.socket, {
        type: 'completion.request',
        request_id: id,
        model: body.model,
        messages: body.messages,
        stream: body.stream,
        tools: body.tools,
        tool_choice: body.tool_choice,
        parallel_tool_calls: body.parallel_tool_calls
      });
    } catch (error) {
      fail(item, error instanceof BridgeError ? error : new BridgeError((error as Error).message));
    }
    return {item, promise};
  };

  app.get('/v1/models', async () => {
    const now = Math.floor(Date.now() / 1000);
    return {
      object: 'list',
      data: ['auto', 'chatgpt-web', 'deepseek-web', 'glm-web'].map(id => ({
        id,
        object: 'model',
        created: now,
        owned_by: 'local-ai-agent'
      }))
    };
  });

  app.get('/v1/events', async (req, reply) => {
    const includeContent = (req.query as {include_content?: string} | undefined)?.include_content === '1';
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    reply.raw.write(': local-ai-agent events connected\n\n');
    const subscriber = {response: reply.raw, includeContent};
    subscribers.add(subscriber);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
    }, 15_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      subscribers.delete(subscriber);
    });
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    const parsed = completionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send(openAiError(parsed.error.issues[0]?.message || 'Invalid completion request.', 'invalid_request'));
    }
    if (!isSupportedModel(parsed.data.model)) {
      return reply.code(400).send(openAiError(
        `Unsupported model ${parsed.data.model}. Use chatgpt-web, deepseek-web, glm-web, or auto.`,
        'model_not_found'
      ));
    }

    const forcedTool = typeof parsed.data.tool_choice === 'object'
      ? parsed.data.tool_choice.function.name
      : undefined;
    if (forcedTool && !parsed.data.tools.some(tool => tool.function.name === forcedTool)) {
      return reply.code(400).send(openAiError(
        `tool_choice references unavailable function ${forcedTool}.`,
        'invalid_tool_choice'
      ));
    }
    if (parsed.data.tool_choice === 'required' && parsed.data.tools.length === 0) {
      return reply.code(400).send(openAiError(
        'tool_choice is required, but no tools were provided.',
        'invalid_tool_choice'
      ));
    }

    const client = selectClient(parsed.data.model);
    if (!client) {
      const unavailable = bridgeUnavailableReason(parsed.data.model);
      publish('bridge.select.rejected', {
        model: parsed.data.model,
        reason: unavailable.code,
        message: unavailable.message,
        matching_clients: matchingClients(parsed.data.model).map(clientSnapshot)
      });
      return reply.code(503).send(openAiError(
        unavailable.message,
        unavailable.code,
        'service_unavailable_error'
      ));
    }
    publish('bridge.select.accepted', {
      model: parsed.data.model,
      ...clientSnapshot(client)
    });

    if (parsed.data.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      const {item} = startCompletion(parsed.data, client, reply.raw);
      if (!item.settled) writeSse(reply.raw, completionChunk(item, {role: 'assistant'}, null));
      const cancelOnDisconnect = () => {
        if (!item.settled && !reply.raw.writableEnded) cancel(item, 'API client disconnected.');
      };
      reply.raw.once('close', cancelOnDisconnect);
      reply.raw.once('error', cancelOnDisconnect);
      reply.raw.socket?.once('close', cancelOnDisconnect);
      item.heartbeat = setInterval(() => {
        if (item.settled) return;
        if (reply.raw.destroyed || reply.raw.socket?.destroyed || reply.raw.socket?.writable === false) {
          cancelOnDisconnect();
          return;
        }
        try {
          reply.raw.write(': bridge heartbeat\n\n', error => {
            if (error) cancelOnDisconnect();
          });
        } catch {
          cancelOnDisconnect();
        }
      }, 1_000);
      return;
    }

    const {promise} = startCompletion(parsed.data, client);
    try {
      return await promise;
    } catch (error) {
      const bridgeError = error as BridgeError;
      return reply.code(bridgeError.statusCode || 502).send(openAiError(
        bridgeError.message,
        bridgeError.code || 'bridge_error',
        'bridge_error'
      ));
    }
  });

  app.addHook('onClose', async () => {
    for (const item of [...pending.values()]) cancel(item, 'Daemon stopped.');
    for (const subscriber of subscribers) subscriber.response.end();
    for (const client of clients) client.socket.close(1001, 'Daemon stopped');
    wss.close();
  });
}
