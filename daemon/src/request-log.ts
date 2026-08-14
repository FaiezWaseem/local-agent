import type {FastifyInstance} from 'fastify';

type RequestLogDetails = {
  method: string;
  statusCode: number;
  url: string;
  toolName?: string;
  arguments?: unknown;
  elapsedMs: number;
};

const LARGE_TEXT_ARGUMENTS = new Set([
  'content',
  'old_text',
  'new_text',
  'old_content',
  'new_content'
]);

function compactValue(value: unknown, key = '', depth = 0): unknown {
  if (typeof value === 'string') {
    if (LARGE_TEXT_ARGUMENTS.has(key)) return `<${value.length} chars>`;
    if (value.length <= 320) return value;
    return `${value.slice(0, 280)}...<${value.length} chars>`;
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 3) return '<nested value>';
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map(item => compactValue(item, '', depth + 1));
    if (value.length > items.length) items.push(`<${value.length - items.length} more items>`);
    return items;
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([entryKey, entryValue]) => [entryKey, compactValue(entryValue, entryKey, depth + 1)])
    );
  }
  return String(value);
}

export function formatRequestLog(details: RequestLogDetails) {
  const isToolCall = Boolean(details.toolName);
  const toolName = details.toolName || '-';
  const argumentsText = isToolCall
    ? ` ${JSON.stringify(compactValue(details.arguments || {}))}`
    : '';
  return `[${details.method}]->${details.statusCode} : [${details.url}] [${isToolCall ? 'YES' : 'NO'}] [${toolName}]${argumentsText} (${details.elapsedMs.toFixed(1)}ms)`;
}

function toolRequest(req: any) {
  const url = String(req.raw?.url || req.url || '');
  const pathname = url.split('?')[0];
  if (req.method === 'POST' && pathname === '/tool') {
    return {
      name: typeof req.body?.name === 'string' ? req.body.name : 'unknown',
      arguments: req.body?.arguments || {}
    };
  }
  if (req.method === 'GET' && pathname.startsWith('/tool/')) {
    return {
      name: 'run_command',
      arguments: {tool_call_id: req.params?.toolCallId || pathname.slice('/tool/'.length), action: 'poll'}
    };
  }
  return undefined;
}

export function installRequestLogging(app: FastifyInstance) {
  const startedAt = new WeakMap<object, number>();

  app.addHook('onRequest', async req => {
    startedAt.set(req, performance.now());
  });

  app.addHook('onResponse', async (req, rep) => {
    if (req.method === 'OPTIONS') return;
    const tool = toolRequest(req);
    console.log(formatRequestLog({
      method: req.method,
      statusCode: rep.statusCode,
      url: String(req.raw?.url || req.url || ''),
      toolName: tool?.name,
      arguments: tool?.arguments,
      elapsedMs: performance.now() - (startedAt.get(req) || performance.now())
    }));
  });
}
