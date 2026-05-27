import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { matchTrigger } from '../../messages/triggers';
import {
    dbGetMessages,
    dbAddMessage,
    dbUpdateMessageStatus,
    dbUpdateMessageSession,
    dbMarkMessagesRead } from '../db';
import { runInlineQuery } from '../agent-drivers';
import { detectLoopProvider, readLoopProviderConfig, readLoopProviderToggles } from '../agent-runner/provider';
import { updateTokens } from '../tokens';
import { injectMessage as injectIntoRunner, getActiveSessionId } from '../agent-runner';
import { AGENT_DISPLAY_NAME_DEFAULTS } from '../../shared/agentDisplayDefaults';
import { answerHelpQuestion, type HelpMessage } from '../help-chat';
import { readBody, json } from '../router';
import { getAgentModel } from '../route-shared';
import { onChatMessage } from '../status-events';
import { isCursorAiEnabled } from '../cursor-ai-policy';
import type { IncomingMessage, ServerResponse } from 'http';
import type { UseFn } from './types';
import { parseJsonUtf8File } from '../json-file';
import { getActiveModel } from '../ollamaManager';

const SSE_KEEPALIVE_MS = 25_000;

type GeneratedReply = {
    text: string;
    provider: 'cursor' | 'loop' | 'meshllm' | 'openrouter' | 'ollama' | 'fallback';
    model: string;
};

export function mount(use: UseFn, rootDir: string, configFile: string): void {
    // ── /api/chat/stream (SSE) ───────────────────────────────────────────────
    use('/api/chat/stream', (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Content-Type' });
            res.end(); return;
        }
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const agentId = url.searchParams.get('agentId') ?? 'frontend';

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*' });

        // Send recent history as seed so client doesn't need a separate fetch
        try {
            const recent = dbGetMessages(agentId).slice(-50);
            for (const row of recent) {
                const ev = { agentId, message: { id: row.id, from: row.from_who, message: row.message, timestamp: row.timestamp, status: row.status } };
                res.write(`data: ${JSON.stringify(ev)}\n\n`);
            }
        } catch { /* ok if db not ready */ }

        const unsub = onChatMessage(agentId, (ev) => {
            try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ }
        });

        const heartbeat = setInterval(() => {
            try { res.write(': keepalive\n\n'); } catch { clearInterval(heartbeat); }
        }, SSE_KEEPALIVE_MS);

        req.on('close', () => {
            clearInterval(heartbeat);
            unsub();
        });
    });

    // ── /api/chat/messages ───────────────────────────────────────────────────
    use('/api/chat/messages', async (req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const agentId = url.searchParams.get('agentId') ?? 'frontend';
        if (req.method === 'GET') {
            try {
                const rows = dbGetMessages(agentId);
                json(res, rows.map(r => ({ id: r.id, from: r.from_who, message: r.message, timestamp: r.timestamp, status: r.status })));
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
        } else if (req.method === 'POST') {
            const body = await readBody(req);
            try {
                const { message } = JSON.parse(body);
                if (!message) { json(res, { error: 'message required' }, 400); return; }
                const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                dbAddMessage(agentId, { id, from: 'user', message, timestamp: new Date().toISOString(), status: 'pending' });
                json(res, { success: true, id });
            } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 400); }
        } else { res.statusCode = 405; res.end('Method not allowed'); }
    });

    // ── /api/chat/mark-read ──────────────────────────────────────────────────
    use('/api/chat/mark-read', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { agentId } = JSON.parse(body);
            if (!agentId) { json(res, { error: 'agentId required' }, 400); return; }
            const updated = dbMarkMessagesRead(agentId);
            json(res, { ok: true, updated });
        } catch (e: unknown) { json(res, { error: e instanceof Error ? e.message : String(e) }, 500); }
    });

    // ── /api/chat ────────────────────────────────────────────────────────────
    const AGENT_IDENTITIES: Record<string, { name: string; role: string; personality: string }> = {
        frontend: { name: AGENT_DISPLAY_NAME_DEFAULTS.frontend, role: 'Frontend Engineer', personality: 'You are practical and detail-oriented. You love clean UI, component architecture, and TypeScript.' },
        reviewer: { name: AGENT_DISPLAY_NAME_DEFAULTS.reviewer, role: 'Code Reviewer', personality: 'You are thorough and fair. You care about code quality, maintainability, and best practices.' },
        devops: { name: AGENT_DISPLAY_NAME_DEFAULTS.devops, role: 'DevOps Engineer', personality: 'You are reliable and systems-minded. You care about CI/CD, builds, infrastructure, and deployment pipelines.' },
        backend: { name: AGENT_DISPLAY_NAME_DEFAULTS.backend, role: 'Backend Engineer', personality: 'You are methodical and API-focused. You care about data models, endpoints, and server architecture.' },
        ux: { name: AGENT_DISPLAY_NAME_DEFAULTS.ux, role: 'UX Designer', personality: 'You are creative and user-focused. You care about usability, accessibility, visual consistency, and modern design patterns.' },
        qa: { name: AGENT_DISPLAY_NAME_DEFAULTS.qa, role: 'QA Engineer', personality: 'You are meticulous and quality-driven. You care about test coverage, edge cases, and regression prevention.' } };

    function buildAgentContext(agentId: string) {
        const me = AGENT_IDENTITIES[agentId] || { name: agentId, role: 'Agent', personality: 'You are a helpful software engineering agent.' };
        const statusFile = resolve(rootDir, `.${agentId}-status.json`);
        let phase = 'idle', currentTask = '', storyNumber = '';
        if (existsSync(statusFile)) {
            try {
                const s = parseJsonUtf8File(statusFile);
                phase = s.currentPhase || 'idle';
                currentTask = s.currentTask || '';
                storyNumber = s.storyNumber || '';
            } catch { /* ok */ }
        }
        const recentMessages = dbGetMessages(agentId).slice(-10);
        const chatHistory = recentMessages
            .map(m => `${m.from_who === 'user' ? 'User' : me.name}: ${m.message}`)
            .join('\n');
        const system = [
            `You are ${me.name}, a ${me.role} on the SDLC Framework SDLC automation team. ${me.personality}`,
            `Current status: phase="${phase}"${currentTask ? `, task="${currentTask}"` : ''}${storyNumber ? `, story=${storyNumber}` : ''}.`,
            'Keep replies concise (1-3 sentences). Be friendly but professional. Stay in character.',
            'If asked who you are, introduce yourself with your name and role.',
            'If asked about your work, reference your current phase and task.',
        ].join(' ');
        const ollamaModel = getActiveModel() || 'qwen3:8b';
        return { me, phase, currentTask, chatHistory, system, ollamaModel };
    }

    async function replyViaOllama(agentId: string, userMsg: string, ctx: ReturnType<typeof buildAgentContext>): Promise<GeneratedReply | null> {
        const prompt = ctx.chatHistory
            ? `Recent conversation:\n${ctx.chatHistory}\n\nUser: ${userMsg}\n${ctx.me.name}:`
            : `User: ${userMsg}\n${ctx.me.name}:`;
        const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
        try {
            const ollamaRes = await fetch(`${ollamaHost}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: ctx.ollamaModel,
                    prompt,
                    system: ctx.system + ' /no_think',
                    stream: false,
                    options: { temperature: 0.7, num_predict: 200, num_ctx: 2048 } }),
                signal: AbortSignal.timeout(45_000) });
            if (ollamaRes.ok) {
                const data = await ollamaRes.json();
                const raw = (data.response || '').trim();
                const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
                if (cleaned) {
                    updateTokens(rootDir, { agentId, source: 'ollama', input: data.prompt_eval_count || 0, output: data.eval_count || 0 });
                    return { text: cleaned, provider: 'ollama', model: ctx.ollamaModel };
                }
            }
        } catch (e) {
            console.log(`[chat] Ollama reply failed for ${agentId}: ${e instanceof Error ? e.message : e}`);
        }
        return null;
    }

    async function replyViaCursorCli(agentId: string, userMsg: string, model: string, ctx: ReturnType<typeof buildAgentContext>): Promise<GeneratedReply | null> {
        const promptText = [
            ctx.system,
            '',
            ctx.chatHistory ? `Recent conversation:\n${ctx.chatHistory}\n` : '',
            `The user just sent you this message: "${userMsg}"`,
            '',
            `Reply as ${ctx.me.name} in 1-3 concise sentences. Output ONLY your reply text, nothing else.`,
        ].filter(Boolean).join('\n');

        // Write prompt to a temp file to avoid Windows command-line length limits
        const tmpDir = resolve(rootDir, '.agent-output');
        if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
        const promptFile = resolve(tmpDir, `btw-prompt-${agentId}-${Date.now()}.txt`);
        writeFileSync(promptFile, promptText);

        const shortPrompt = `Read the file ${promptFile} and follow the instructions inside it. Reply concisely as ${ctx.me.name}.`;
        try {
            console.log(`[chat] Routing ${agentId} reply through IDE CLI (model=${model})`);
            const raw = await runInlineQuery(shortPrompt, rootDir, resolve(rootDir, '.sdlc-framework.config.json'), { model, timeout: 60_000 });
            const cleaned = raw
                .replace(/^```[\s\S]*?```$/gm, '')
                .replace(/^\s*>\s*/gm, '')
                .trim();
            try { unlinkSync(promptFile); } catch { /* cleanup non-critical */ }
            if (cleaned) return { text: cleaned, provider: 'cursor', model };
        } catch (e) {
            console.log(`[chat] IDE CLI reply failed for ${agentId}: ${e instanceof Error ? e.message : e}`);
            try { unlinkSync(promptFile); } catch { /* cleanup */ }
        }
        return null;
    }

    function isLoopProviderModelId(model: string): boolean {
        return model.includes('/') || model.includes(':');
    }

    async function replyViaLoopProvider(agentId: string, userMsg: string, ctx: ReturnType<typeof buildAgentContext>, modelOverride?: string): Promise<GeneratedReply | null> {
        const configPath = resolve(rootDir, '.sdlc-framework.config.json');
        let providerCfg: ReturnType<typeof readLoopProviderConfig>;
        try { providerCfg = readLoopProviderConfig(configPath); } catch { return null; }
        const provider = detectLoopProvider(providerCfg.baseUrl);
        const providerEnabled = readLoopProviderToggles(configPath);
        if (provider === 'meshllm' && !providerEnabled.meshllm) return null;
        if (provider === 'openrouter' && !providerEnabled.openrouter) return null;
        if (provider === 'ollama' && !providerEnabled.ollama) return null;
        // Skip if loop provider is Ollama itself (avoid double-trying)
        if (providerCfg.baseUrl.includes(':11434')) return null;
        const messages: Array<{ role: string; content: string }> = [];
        if (ctx.chatHistory) {
            for (const line of ctx.chatHistory.split('\n').filter(Boolean)) {
                if (line.startsWith('User: ')) messages.push({ role: 'user', content: line.slice(6) });
                else { const sep = line.indexOf(': '); messages.push({ role: 'assistant', content: sep >= 0 ? line.slice(sep + 2) : line }); }
            }
        }
        messages.push({ role: 'user', content: userMsg });
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (providerCfg.apiKey) headers['Authorization'] = `Bearer ${providerCfg.apiKey}`;
        try {
            const r = await fetch(`${providerCfg.baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: modelOverride || providerCfg.model || 'auto',
                    messages: [{ role: 'system', content: ctx.system }, ...messages],
                    max_tokens: 200,
                    temperature: 0.7,
                }),
                signal: AbortSignal.timeout(30_000),
            });
            if (!r.ok) return null;
            const data = await r.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
            const text = data.choices?.[0]?.message?.content?.trim();
            if (!text) return null;
            const tokenSource = provider === 'meshllm' ? 'meshllm' : 'cloud';
            updateTokens(rootDir, { agentId, source: tokenSource, input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 });
            return {
                text,
                provider: provider === 'meshllm' || provider === 'openrouter' ? provider : 'loop',
                model: modelOverride || providerCfg.model || 'auto',
            };
        } catch (e) {
            console.log(`[chat] Loop provider reply failed for ${agentId}: ${e instanceof Error ? e.message : e}`);
            return null;
        }
    }

    async function generateAgentReply(agentId: string, userMsg: string): Promise<GeneratedReply> {
        const ctx = buildAgentContext(agentId);
        const model = getAgentModel(agentId, rootDir);
        const agentModelIsLoopProvider = model !== 'auto' && model !== 'local' && isLoopProviderModelId(model);
        const isCursorCliModel = model !== 'auto' && model !== 'local' && !agentModelIsLoopProvider;
        const providerEnabled = readLoopProviderToggles(resolve(rootDir, '.sdlc-framework.config.json'));

        // The selected loop provider is the user's explicit /btw routing choice.
        // Cursor is only a fallback for agents with a cloud model configured.
        const loopReply = await replyViaLoopProvider(agentId, userMsg, ctx, agentModelIsLoopProvider ? model : undefined);
        if (loopReply) return loopReply;

        if (isCursorCliModel && isCursorAiEnabled(resolve(rootDir, '.sdlc-framework.config.json'))) {
            const cloudReply = await replyViaCursorCli(agentId, userMsg, model, ctx);
            if (cloudReply) return cloudReply;
            console.log(`[chat] Cloud reply failed for ${agentId}, falling back to Ollama`);
        } else if (isCursorCliModel) {
            console.log(`[chat] Cursor fallback skipped for ${agentId}; Cursor AI is disabled`);
        }

        if (providerEnabled.ollama) {
            const ollamaReply = await replyViaOllama(agentId, userMsg, ctx);
            if (ollamaReply) return ollamaReply;
        }

        if (ctx.phase === 'idle' || !ctx.phase) {
            return {
                text: `Hey, I'm ${ctx.me.name} (${ctx.me.role}). I don't have an active workflow right now — your message is noted and I'll pick it up when I start my next task.`,
                provider: 'fallback',
                model: 'none',
            };
        }
        return {
            text: `I'm ${ctx.me.name} (${ctx.me.role}), currently in the "${ctx.phase}" phase${ctx.currentTask ? ` working on: ${ctx.currentTask}` : ''}. I'll address your message at my next phase break.`,
            provider: 'fallback',
            model: 'none',
        };
    }

    function activeRunnerModelLabel(agentId: string): string {
        const configured = getAgentModel(agentId, rootDir);
        if (configured !== 'auto' && configured !== 'local') return configured;
        try {
            return readLoopProviderConfig(resolve(rootDir, '.sdlc-framework.config.json')).model || configured;
        } catch {
            return configured;
        }
    }

    use('/api/chat', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method not allowed'); return; }
        const body = await readBody(req);
        try {
            const { agentId, message } = JSON.parse(body);
            let triggerMatched = false, triggerDescription = '';
            const msgStatus = message.from === 'user' ? 'pending' : (message.status ?? 'pending');
            const msgId = message.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            dbAddMessage(agentId, { id: msgId, from: message.from ?? agentId, message: message.message ?? message.text ?? '', timestamp: message.timestamp ?? new Date().toISOString(), status: msgStatus });
            if (message.from === 'user') {
                const msgText = message.message || message.text || '';

                // If a loop-driver AgentRunner is active, inject directly — real interrupt.
                // Tag the stored message with the active sessionId so history is session-scoped.
                const activeSessionId = getActiveSessionId(agentId);
                const injected = activeSessionId ? injectIntoRunner(agentId, msgText) : false;
                if (injected && activeSessionId) {
                    dbUpdateMessageSession(msgId, 'read', activeSessionId);
                    const activeModel = activeRunnerModelLabel(agentId);
                    json(res, { ok: true, injected: true, sessionId: activeSessionId, replyProvider: 'active-runner', replyModel: activeModel, triggerMatched: false, triggerDescription: '' });
                    return;
                }

                // No active runner — check for workflow trigger then generate a simulated reply
                const triggerMatch = matchTrigger(msgText);
                if (triggerMatch) {
                    triggerMatched = true; triggerDescription = triggerMatch.description;
                    dbUpdateMessageStatus(msgId, 'acted');
                    const replyText = `Trigger matched: "${triggerMatch.trigger}". ${triggerMatch.description}.`;
                    const ackId = `ack-${Date.now()}`;
                    dbAddMessage(agentId, { id: ackId, from: agentId, message: replyText, timestamp: new Date().toISOString(), status: 'read' });
                } else {
                    dbUpdateMessageStatus(msgId, 'read');
                    const reply = await generateAgentReply(agentId, msgText);
                    const replyText = reply.text;
                    console.log(`[chat] /btw ${agentId} reply provider=${reply.provider} model=${reply.model}`);
                    const ackId = `ack-${Date.now()}`;
                    dbAddMessage(agentId, { id: ackId, from: agentId, message: replyText, timestamp: new Date().toISOString(), status: 'read' });
                    json(res, { ok: true, triggerMatched, triggerDescription, replyProvider: reply.provider, replyModel: reply.model });
                    return;
                }
            }
            json(res, { ok: true, triggerMatched, triggerDescription });
        } catch (e) { json(res, { error: String(e) }, 500); }
    });

    // ── /api/chat/direct ────────────────────────────────────────────────────
    // POST { agentId, messages: [{role, content}] } → { reply, model, provider }
    // Calls the agent's configured model directly without storing to the message DB.
    use('/api/chat/direct', async (req, res) => {
        if (req.method !== 'POST') { json(res, { error: 'Method not allowed' }, 405); return; }
        try {
            const raw = await readBody(req);
            const { agentId, messages } = JSON.parse(raw) as { agentId: string; messages: Array<{ role: string; content: string }> };
            if (!agentId || !Array.isArray(messages)) { json(res, { error: 'agentId and messages required' }, 400); return; }

            const model = getAgentModel(agentId, rootDir);
            const configPath = resolve(rootDir, '.sdlc-framework.config.json');

            // Anthropic Messages API
            if (model.startsWith('anthropic/')) {
                const apiKey = process.env.ANTHROPIC_API_KEY;
                if (apiKey) {
                    const modelId = model.slice('anthropic/'.length);
                    const r = await fetch('https://api.anthropic.com/v1/messages', {
                        method: 'POST',
                        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
                        body: JSON.stringify({ model: modelId, messages, max_tokens: 1024 }),
                        signal: AbortSignal.timeout(60_000),
                    });
                    if (r.ok) {
                        const data = await r.json() as { content: Array<{ text: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
                        const reply = data.content?.[0]?.text?.trim() ?? '';
                        updateTokens(rootDir, { agentId, source: 'cloud', input: data.usage?.input_tokens ?? 0, output: data.usage?.output_tokens ?? 0 });
                        json(res, { reply, model, provider: 'anthropic' }); return;
                    }
                }
            }

            // Cloud models via loop provider (openai/, deepseek/, google/, etc. and anthropic/ fallback)
            if (model.includes('/') || model.includes(':')) {
                let providerCfg: ReturnType<typeof readLoopProviderConfig>;
                try { providerCfg = readLoopProviderConfig(configPath); } catch { providerCfg = { baseUrl: '', model: '' }; }
                if (providerCfg.baseUrl && !providerCfg.baseUrl.includes(':11434')) {
                    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                    if (providerCfg.apiKey) headers['Authorization'] = `Bearer ${providerCfg.apiKey}`;
                    const r = await fetch(`${providerCfg.baseUrl}/chat/completions`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ model, messages, max_tokens: 1024 }),
                        signal: AbortSignal.timeout(60_000),
                    });
                    if (r.ok) {
                        const data = await r.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
                        const reply = data.choices?.[0]?.message?.content?.trim() ?? '';
                        updateTokens(rootDir, { agentId, source: 'cloud', input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 });
                        json(res, { reply, model, provider: 'loop' }); return;
                    }
                }
            }

            // Local: try Ollama then MLX (both OpenAI-compat)
            const localModel = model === 'auto' || model === 'local' ? (getActiveModel() || 'llama3') : model;
            const localTargets = [
                { host: process.env.OLLAMA_HOST || 'http://localhost:11434', provider: 'ollama', tokenSource: 'ollama' as const },
                { host: process.env.MLX_HOST || 'http://localhost:8082', provider: 'mlx', tokenSource: 'cloud' as const },
            ];
            for (const { host, provider, tokenSource } of localTargets) {
                try {
                    const r = await fetch(`${host}/v1/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: localModel, messages, max_tokens: 1024 }),
                        signal: AbortSignal.timeout(60_000),
                    });
                    if (r.ok) {
                        const data = await r.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
                        const reply = data.choices?.[0]?.message?.content?.trim() ?? '';
                        updateTokens(rootDir, { agentId, source: tokenSource, input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 });
                        json(res, { reply, model: localModel, provider }); return;
                    }
                } catch { /* try next */ }
            }

            json(res, { error: 'No provider available for the configured model. Check Ollama/MLX is running or configure a loop provider.' }, 503);
        } catch (e) { json(res, { error: String(e) }, 500); }
    });

    // ── /api/help/chat ────────────────────────────────────────────────────
    use('/api/help/chat', async (req, res) => {
        if (req.method !== 'POST') { json(res, { error: 'Method not allowed' }, 405); return; }
        try {
            const raw = await readBody(req);
            const body = JSON.parse(raw) as { message?: string; history?: HelpMessage[] };
            const message = (body.message ?? '').trim();
            if (!message) { json(res, { error: 'message is required' }, 400); return; }
            const history: HelpMessage[] = Array.isArray(body.history) ? body.history : [];
            const result = await answerHelpQuestion(message, history, rootDir, configFile);
            json(res, result);
        } catch (e) { json(res, { error: String(e) }, 500); }
    });
}
