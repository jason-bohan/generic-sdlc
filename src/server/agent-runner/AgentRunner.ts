import { EventEmitter } from 'events';
import type { Message, RunnerEvent, RunnerEventType } from './types';
import type { OpenAICompatibleProvider } from './provider';
import { AGENT_TOOLS, executeToolCall } from './tools';
import { isEmbeddingReady, ollamaHost } from '../ollamaManager';
import { ragQuery } from '../ragIndex';

const MAX_TURNS = 80;
const TOOL_RESULT_STORAGE_CAP = 3000;

/**
 * Some local GGUFs (e.g. via MeshLLM/llama.cpp) emit tool calls as a markdown
 * ```json {"name":..,"arguments":..} ``` block instead of the structured
 * tool_calls field. Parse and promote to a proper tool call object.
 */
function _extractTextToolCall(content: string): import('./types').ToolCall | null {
    // Try markdown code block first: ```json { ... } ```
    const blockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    // Fall back to bare JSON object anywhere in the content
    const bareMatch = !blockMatch ? content.match(/(\{[\s\S]*\})/) : null;
    const jsonStr = blockMatch ? blockMatch[1] : (bareMatch ? bareMatch[1] : null);
    if (!jsonStr) return null;
    try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        const name = typeof parsed.name === 'string' ? parsed.name : null;
        if (!name) return null;
        const args = parsed.arguments ?? parsed.parameters ?? {};
        return {
            id: `textcall_${Date.now()}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
        };
    } catch {
        return null;
    }
}

/** Trim long tool results before persisting to avoid bloating the DB row. */
function compactForStorage(messages: Message[]): Message[] {
    return messages.map((m) => {
        if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > TOOL_RESULT_STORAGE_CAP) {
            return {
                ...m,
                content: m.content.slice(0, TOOL_RESULT_STORAGE_CAP) +
                    `\n[...trimmed for storage — full length ${m.content.length}]`,
            };
        }
        return m;
    });
}

export class AgentRunner extends EventEmitter {
    public readonly sessionId: string;
    private messages: Message[] = [];
    private injectionQueue: string[] = [];
    private _running = false;
    private _aborted = false;
    private turnCount = 0;
    private consecutiveNudges = 0;
    private onCheckpoint?: (messages: Message[]) => void;

    constructor(
        public readonly agentId: string,
        private readonly provider: OpenAICompatibleProvider,
        private readonly workspaceDir: string,
        private readonly frameworkDir: string,
        private readonly configPath: string,
        opts?: {
            sessionId?: string;
            initialMessages?: Message[];
            onCheckpoint?: (messages: Message[]) => void;
        },
    ) {
        super();
        this.sessionId = opts?.sessionId ?? crypto.randomUUID();
        if (opts?.initialMessages) this.messages = [...opts.initialMessages];
        this.onCheckpoint = opts?.onCheckpoint;
    }

    get isRunning(): boolean { return this._running; }

    /**
     * Inject a /btw message. Picked up before the next LLM call
     * (i.e. after the current tool execution finishes).
     */
    inject(text: string): void {
        this.injectionQueue.push(text);
        this._emit('injection', { queued: text, queueLength: this.injectionQueue.length });
    }

    abort(): void {
        this._aborted = true;
        this._running = false;
    }

    getMessages(): Message[] { return [...this.messages]; }

    async run(systemPrompt: string, initialPrompt: string): Promise<void> {
        this._running = true;
        this._aborted = false;
        this.turnCount = 0;
        const promptWithContext = await this._withRagContext(initialPrompt);

        // If resuming an existing session, messages are already loaded;
        // otherwise seed with system prompt + initial user prompt.
        if (this.messages.length === 0) {
            this.messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: promptWithContext },
            ];
        } else {
            // Continuing — append the new prompt as a user message
            this.messages.push({ role: 'user', content: promptWithContext });
        }

        this._emit('start', { initialPrompt: promptWithContext.slice(0, 300), sessionId: this.sessionId });

        try {
            while (this._running && !this._aborted && this.turnCount < MAX_TURNS) {
                // Drain injection queue — the interrupt moment
                if (this.injectionQueue.length > 0) {
                    const pending = this.injectionQueue.splice(0);
                    for (const msg of pending) {
                        this.messages.push({ role: 'user', content: `[/btw]: ${msg}` });
                        this._emit('injection', { applied: msg });
                    }
                }

                this.turnCount++;

                let response;
                try {
                    response = await this.provider.complete(this.messages, AGENT_TOOLS);
                } catch (e) {
                    this._emit('error', { message: e instanceof Error ? e.message : String(e), turn: this.turnCount });
                    break;
                }

                const msg = response.message;

                // Some local models (e.g. raw GGUFs via MeshLLM/llama.cpp) output tool
                // calls as a ```json {"name":..,"arguments":..} ``` block in content
                // instead of a structured tool_calls field. Parse and promote them.
                if ((!msg.tool_calls || msg.tool_calls.length === 0) && typeof msg.content === 'string') {
                    const extracted = _extractTextToolCall(msg.content);
                    if (extracted) {
                        msg.content = null;
                        msg.tool_calls = [extracted];
                    }
                }

                this.messages.push(msg);

                if (!msg.tool_calls || msg.tool_calls.length === 0) {
                    // If the model wrote a planning message instead of calling a tool,
                    // nudge it once or twice then give up to avoid burning all turns.
                    const textContent = typeof msg.content === 'string' ? msg.content.toLowerCase() : '';
                    const isPlanningText = /\b(i will|i'll|let me|now i|next i|i need to|i should|i am going to|step \d|first,|second,|third,)\b/.test(textContent);
                    if (isPlanningText && this.consecutiveNudges < 3 && this.turnCount < MAX_TURNS - 1) {
                        this.consecutiveNudges++;
                        this._emit('message', { content: `[nudge] Model wrote plan text (nudge ${this.consecutiveNudges}/3)`, turn: this.turnCount });
                        this.messages.push({ role: 'user', content: 'Call the appropriate tool now to execute that action. Do not describe what you will do — call the tool directly.' });
                        continue;
                    }
                    this.consecutiveNudges = 0;
                    this._emit('message', { content: msg.content, turn: this.turnCount });
                    this._running = false;
                    break;
                }
                this.consecutiveNudges = 0;

                for (const toolCall of msg.tool_calls) {
                    if (this._aborted) break;

                    this._emit('tool_call', { name: toolCall.function.name, id: toolCall.id });

                    let output: string;
                    try {
                        let parsedArgs: unknown = {};
                        try { parsedArgs = JSON.parse(toolCall.function.arguments); } catch { /* keep empty */ }
                        output = await executeToolCall(
                            toolCall.function.name,
                            parsedArgs,
                            this.workspaceDir,
                            this.frameworkDir,
                            this.agentId,
                            this.configPath,
                        );
                    } catch (e) {
                        output = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
                    }

                    this._emit('tool_result', { name: toolCall.function.name, id: toolCall.id, outputLength: output.length });

                    this.messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: output,
                    });
                }

                // Checkpoint after each complete tool round-trip
                this.onCheckpoint?.(compactForStorage(this.messages));
            }

            this._emit('complete', { turns: this.turnCount, aborted: this._aborted, sessionId: this.sessionId });
        } finally {
            this._running = false;
        }
    }

    private _emit(type: RunnerEventType, data?: unknown): void {
        const event: RunnerEvent = {
            type,
            agentId: this.agentId,
            timestamp: new Date().toISOString(),
            data,
        };
        this.emit(type, event);
        this.emit('event', event);
    }

    private async _withRagContext(prompt: string): Promise<string> {
        if (!isEmbeddingReady()) return prompt;
        try {
            const context = await ragQuery(this.workspaceDir, this.frameworkDir, prompt, ollamaHost());
            if (!context) return prompt;
            this._emit('message', {
                content: `[rag] Injected retrieved context from ${this.workspaceDir}`,
                turn: this.turnCount,
            });
            return [
                context,
                '',
                'Use the retrieved context as grounding for file names, APIs, and implementation details. Verify with tools before editing.',
                '',
                prompt,
            ].join('\n');
        } catch {
            return prompt;
        }
    }
}
