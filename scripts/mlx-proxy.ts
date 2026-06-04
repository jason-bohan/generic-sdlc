#!/usr/bin/env tsx
/**
 * MLX Tool-Call Proxy
 *
 * Sits between opencode/SDLC framework and `mlx_lm server`.
 * The MLX server emits tool calls as `<tools>{"name":"..","arguments":{..}}</tools>`
 * text instead of the OpenAI `tool_calls` array. This proxy detects that text and
 * promotes it to a proper `tool_calls` structure so any OpenAI-compatible client
 * (opencode, the SDLC agent runner, etc.) can execute them.
 *
 * Usage:
 *   tsx scripts/mlx-proxy.ts
 *
 * Env vars:
 *   MLX_PROXY_PORT  – listen port (default 8084)
 *   MLX_HOST        – upstream MLX server (default http://localhost:8082)
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const PROXY_PORT = parseInt(process.env.MLX_PROXY_PORT || '8084', 10);
const UPSTREAM = (process.env.MLX_HOST || 'http://localhost:8082').replace(/\/+$/, '');

const [UP_PROTO, UP_HOST, UP_PORT] = (() => {
  const u = new URL(UPSTREAM);
  return [u.protocol, u.hostname, parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10)];
})();

function isChatCompletionsReq(method: string, url: string): boolean {
  return method === 'POST' && url.includes('/chat/completions');
}

function extractToolCalls(content: string): { name: string; arguments: string }[] | null {
  const calls: { name: string; arguments: string }[] = [];

  // 1. Try XML-wrapped tool calls (<tools>, <function>, <tool_call>)
  const xmlRe = /<(?:tools|function|tool_call)>\s*(\{[\s\S]*?\})\s*<\/(?:tools|function|tool_call)>/g;
  let match: RegExpExecArray | null;
  while ((match = xmlRe.exec(content)) !== null) {
    const tc = _proxyParseToolCall(match[1]);
    if (tc) calls.push(tc);
  }

  // 2. Try bare JSON objects (no XML wrapping) — the model may output multiple
  //    tool calls separated by chat template tokens (<|im_start|>, <|im_end|>)
  //    or whitespace. Use balanced-brace matching for correct nesting.
  if (calls.length === 0) {
    let start = content.indexOf('{');
    while (start !== -1) {
      let depth = 0;
      let i = start;
      while (i < content.length) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') {
          depth--;
          if (depth === 0) {
            const tc = _proxyParseToolCall(content.slice(start, i + 1));
            if (tc) calls.push(tc);
            break;
          }
        }
        i++;
      }
      start = content.indexOf('{', start + 1);
    }
  }

  return calls.length > 0 ? calls : null;
}

function _proxyParseToolCall(jsonStr: string): { name: string; arguments: string } | null {
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const name = typeof parsed.name === 'string' ? parsed.name : null;
    if (!name) return null;
    const args = parsed.arguments ?? parsed.parameters ?? {};
    return { name, arguments: JSON.stringify(args) };
  } catch {
    return null;
  }
}

function transformJsonResponse(body: string): string {
  try {
    const data = JSON.parse(body);
    const choice = data.choices?.[0];
    if (!choice || !choice.message || typeof choice.message.content !== 'string') return body;

    const content: string = choice.message.content;
    const toolCalls = extractToolCalls(content);
    if (!toolCalls) return body;

    choice.message.content = null;
    choice.message.tool_calls = toolCalls.map((tc, i) => ({
      id: `call_${Date.now()}_${i}`,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }));
    choice.finish_reason = 'tool_calls';
    return JSON.stringify(data);
  } catch { return body; }
}

function proxyRequest(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  bodyChunks: Buffer[],
  isChat: boolean,
) {
  const body = Buffer.concat(bodyChunks);
  const reqFn = UP_PROTO === 'https:' ? httpsRequest : httpRequest;

  const upstreamReq = reqFn(
    {
      hostname: UP_HOST,
      port: UP_PORT,
      path: clientReq.url,
      method: clientReq.method,
      headers: { ...clientReq.headers, host: `${UP_HOST}:${UP_PORT}`, connection: 'keep-alive' },
      timeout: 600_000,
    },
    (upstreamRes) => {
      const resChunks: Buffer[] = [];

      upstreamRes.on('data', (chunk: Buffer) => resChunks.push(chunk));
      upstreamRes.on('end', () => {
        const raw = Buffer.concat(resChunks);

        if (isChat) {
          const ct = upstreamRes.headers['content-type'] || '';
          if (ct.includes('text/event-stream')) {
            handleStreaming(raw.toString('utf-8'), clientRes);
          } else {
            const transformed = transformJsonResponse(raw.toString('utf-8'));
            writeResponse(clientRes, upstreamRes.statusCode || 200, upstreamRes.headers, Buffer.from(transformed, 'utf-8'));
          }
        } else {
          writeResponse(clientRes, upstreamRes.statusCode || 200, upstreamRes.headers, raw);
        }
      });

      upstreamRes.on('error', (err) => {
        writeResponse(clientRes, 502, { 'content-type': 'text/plain' }, Buffer.from(`Upstream error: ${err.message}`));
      });
    },
  );

  upstreamReq.on('error', (err) => {
    writeResponse(clientRes, 502, { 'content-type': 'text/plain' }, Buffer.from(`Proxy error: ${err.message}`));
  });

  upstreamReq.write(body);
  upstreamReq.end();
}

function handleStreaming(sseText: string, clientRes: ServerResponse) {
  const lines = sseText.split('\n');
  let contentAccumulator = '';
  const chunks: { data: string; isDone: boolean }[] = [];
  let foundToolCalls = false;
  let allContent = '';

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const jsonStr = line.slice(6).trim();
    if (jsonStr === '[DONE]') {
      chunks.push({ data: line, isDone: true });
      continue;
    }
    try {
      const chunk = JSON.parse(jsonStr);
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content && typeof delta.content === 'string') {
        allContent += delta.content;
      }
      chunks.push({ data: jsonStr, isDone: chunk.choices?.[0]?.finish_reason === 'stop' });
    } catch { chunks.push({ data: jsonStr, isDone: false }); }
  }

  foundToolCalls = !!extractToolCalls(allContent);

  if (!foundToolCalls) {
    // Pass through unchanged
    const headers: Record<string, string> = {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    };
    writeResponse(clientRes, 200, headers, Buffer.from(sseText, 'utf-8'));
    return;
  }

  // Tool calls found — reconstruct SSE with proper tool_calls format
  const toolCalls = extractToolCalls(allContent)!;
  const responseId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = extractModelFromChunks(chunks) || 'unknown';
  let sseOut = '';

  // First chunk: role + first tool call declaration
  sseOut += `data: ${JSON.stringify({
    id: responseId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map((tc, i) => ({
          index: i,
          id: `call_${Date.now()}_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: '' },
        })),
      },
      finish_reason: null,
    }],
  })}\n\n`;

  // Content chunks for each tool call
  for (let i = 0; i < toolCalls.length; i++) {
    sseOut += `data: ${JSON.stringify({
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: i,
            function: { arguments: toolCalls[i].arguments },
          }],
        },
        finish_reason: null,
      }],
    })}\n\n`;
  }

  // Final chunk: finish_reason = tool_calls
  sseOut += `data: ${JSON.stringify({
    id: responseId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'tool_calls',
    }],
  })}\n\n`;

  sseOut += 'data: [DONE]\n\n';

  const headers: Record<string, string> = {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  };
  writeResponse(clientRes, 200, headers, Buffer.from(sseOut, 'utf-8'));
}

function extractModelFromChunks(chunks: { data: string }[]): string | null {
  for (const c of chunks) {
    try {
      const p = JSON.parse(c.data);
      if (p.model) return p.model;
    } catch { /* skip */ }
  }
  return null;
}

function writeResponse(
  res: ServerResponse,
  statusCode: number,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
) {
  const safeHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'transfer-encoding' || lk === 'content-encoding') continue;
    if (Array.isArray(v)) safeHeaders[k] = v.join(', ');
    else if (v !== undefined) safeHeaders[k] = v;
  }
  safeHeaders['content-length'] = String(body.length);
  res.writeHead(statusCode, safeHeaders);
  res.end(body);
}

const server = createServer((clientReq, clientRes) => {
  const bodyChunks: Buffer[] = [];
  const isChat = isChatCompletionsReq(clientReq.method || 'GET', clientReq.url || '');

  clientReq.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
  clientReq.on('end', () => proxyRequest(clientReq, clientRes, bodyChunks, isChat));
  clientReq.on('error', () => { clientRes.statusCode = 400; clientRes.end(); });
});

server.listen(PROXY_PORT, () => {
  const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
  console.log(`${bold('MLX proxy')}  ${UPSTREAM} ← ${bold(`http://localhost:${PROXY_PORT}`)}`);
  console.log(dim(`  Set MLX_PROXY_PORT and MLX_HOST env vars to override`));
  console.log(dim(`  Tool-call <tools> XML → structured tool_calls`));
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PROXY_PORT} is already in use — is the proxy already running?`);
    process.exit(1);
  }
  console.error('Server error:', err.message);
  process.exit(1);
});
