import { EventEmitter } from 'events';
import type { Message, RunnerEvent, RunnerEventType } from './types';
import type { OpenAICompatibleProvider } from './provider';
import { AGENT_TOOLS, executeToolCall } from './tools';

const MAX_TURNS = 80;
const TOOL_RESULT_STORAGE_CAP = 3000;

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

        // If resuming an existing session, messages are already loaded;
        // otherwise seed with system prompt + initial user prompt.
        if (this.messages.length === 0) {
            this.messages = [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: initialPrompt },
            ];
        } else {
            // Continuing — append the new prompt as a user message
            this.messages.push({ role: 'user', content: initialPrompt });
        }

        this._emit('start', { initialPrompt: initialPrompt.slice(0, 300), sessionId: this.sessionId });

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
                this.messages.push(msg);

                if (!msg.tool_calls || msg.tool_calls.length === 0) {
                    this._emit('message', { content: msg.content, turn: this.turnCount });
                    this._running = false;
                    break;
                }

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
}
