import { EventEmitter } from 'events';
import type { Message, RunnerEvent, RunnerEventType } from './types';
import type { OpenAICompatibleProvider } from './provider';
import { AGENT_TOOLS, executeToolCall } from './tools';
import { isEmbeddingReady, ollamaHost } from '../ollamaManager';
import { ragQuery } from '../ragIndex';

const MAX_TURNS = 80;
const TOOL_RESULT_STORAGE_CAP = 3000;
const PHASE_COMPLETE_SENTINEL = 'PHASE_COMPLETE::';

/**
 * Phases that must produce at least one written file before they may complete.
 * Small local models (e.g. Qwen2.5-Coder-14B via MLX) reliably emit valid tool
 * calls but tend to skip the write step and jump straight to complete_phase —
 * often escalating to next_phase="error" when nudged. These phases get a guard.
 */
const MUTATION_REQUIRED_PHASES = new Set(['generating-code']);
const MAX_PREMATURE_COMPLETE_BLOCKS = 2;

/**
 * Some local providers emit tool calls as text instead of the structured tool_calls field:
 * - MeshLLM/llama.cpp: ```json {"name":..,"arguments":..} ``` markdown blocks
 * - MLX (Qwen2.5-Coder etc.): <tools>{"name":..,"arguments":..}</tools> XML blocks
 * Parse and promote to a proper tool call object.
 */
export function _extractTextToolCall(content: string): import('./types').ToolCall | null {
    // Try MLX-style <tools>{ ... }</tools> or <function>{ ... }</function> block first
    const xmlMatch = content.match(/<(?:tools|function|tool_call)>\s*(\{[\s\S]*?\})\s*<\/(?:tools|function|tool_call)>/);
    if (xmlMatch) {
        const tc = _parseToolCallJson(xmlMatch[1]);
        if (tc) return tc;
    }
    // Try markdown code block: ```json { ... } ```
    const blockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (blockMatch) {
        const tc = _parseToolCallJson(blockMatch[1]);
        if (tc) return tc;
    }
    // Fall back: find the first complete, valid JSON object with a "name" field
    // Handles bare JSON (no XML wrapping) and multiple objects separated by
    // chat template tokens (<|im_start|>, <|im_end|>) or whitespace.
    let start = content.indexOf('{');
    while (start !== -1) {
        let depth = 0;
        let i = start;
        while (i < content.length) {
            if (content[i] === '{') depth++;
            else if (content[i] === '}') {
                depth--;
                if (depth === 0) {
                    const candidate = content.slice(start, i + 1);
                    const tc = _parseToolCallJson(candidate);
                    if (tc) return tc;
                    break;
                }
            }
            i++;
        }
        start = content.indexOf('{', start + 1);
    }
    return null;
}

function _parseToolCallJson(jsonStr: string): import('./types').ToolCall | null {
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
    private _phaseCompleted = false;
    private _completePhaseAttempted = false;
    private mutationCount = 0;
    private prematureCompleteBlocks = 0;
    private phaseName = '';
    // Cumulative token usage across all turns in this run, summed from each
    // completion's usage. Surfaced on the 'complete' event so the registry can
    // record it to the token ledger.
    private usageInput = 0;
    private usageOutput = 0;
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

    /** True while the current phase requires a file change that hasn't happened yet. */
    private get _mutationRequired(): boolean {
        return MUTATION_REQUIRED_PHASES.has(this.phaseName) && this.mutationCount === 0;
    }

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
        // Extract the SDLC phase name from the prompt so phase-specific guards
        // (mutation requirement) can apply. Handles both prompt formats:
        //   spawn:    Run SDLC phase "generating-code"
        //   continue: ...currently in phase 'generating-code'...
        const phaseMatch = initialPrompt.match(/phase\s+['"]([^'"]+)['"]/i);
        this.phaseName = phaseMatch ? phaseMatch[1] : '';
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

                if (response.usage) {
                    this.usageInput += response.usage.inputTokens;
                    this.usageOutput += response.usage.outputTokens;
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
                    const textContent = typeof msg.content === 'string' ? msg.content.toLowerCase() : '';
                    // Nudge 1: model wrote planning text instead of calling a tool
                    const isPlanningText = /\b(i will|i'll|let me|now i|next i|i need to|i should|i am going to|step \d|first,|second,|third,)\b/.test(textContent);
                    if (isPlanningText && this.consecutiveNudges < 3 && this.turnCount < MAX_TURNS - 1) {
                        this.consecutiveNudges++;
                        this._emit('message', { content: `[nudge] Model wrote plan text (nudge ${this.consecutiveNudges}/3)`, turn: this.turnCount });
                        this.messages.push({ role: 'user', content: 'Call the appropriate tool now to execute that action. Do not describe what you will do — call the tool directly.' });
                        continue;
                    }
                    // Nudge 2: model stopped (empty or text) before calling complete_phase
                    if (!this._phaseCompleted && this.consecutiveNudges < 2 && this.turnCount < MAX_TURNS - 1) {
                        this.consecutiveNudges++;
                        if (this._mutationRequired) {
                            // Don't push the model toward complete_phase when it hasn't done
                            // the work — that just makes it escalate to next_phase="error".
                            this._emit('message', { content: `[nudge] No files changed yet in ${this.phaseName} (nudge ${this.consecutiveNudges}/2)`, turn: this.turnCount });
                            this.messages.push({ role: 'user', content: 'You have not changed any files yet. This phase requires implementing the code: call write_file with the actual file contents now. Do NOT call complete_phase until at least one file has been written.' });
                        } else if (this._completePhaseAttempted) {
                            // The model already called complete_phase but it was rejected
                            // (missing required outputs, server error, etc.). Don't tell it
                            // to "call complete_phase" — it tried that. Tell it to fix the
                            // error instead.
                            this._emit('message', { content: `[nudge] complete_phase was rejected (nudge ${this.consecutiveNudges}/2)`, turn: this.turnCount });
                            this.messages.push({ role: 'user', content: 'Your last complete_phase call was rejected by the server. Read the error above, fix the outputs (ensure all required fields are present), then call complete_phase again.' });
                        } else {
                            this._emit('message', { content: `[nudge] Stopped without complete_phase (nudge ${this.consecutiveNudges}/2)`, turn: this.turnCount });
                            this.messages.push({ role: 'user', content: 'You have not called complete_phase yet. You MUST call complete_phase now to advance the workflow. Do not output text — call the tool directly.' });
                        }
                        continue;
                    }
                    this.consecutiveNudges = 0;
                    this._emit('message', { content: msg.content, turn: this.turnCount });
                    this._running = false;
                    break;
                }
                this.consecutiveNudges = 0;

                let phaseCompleted = false;
                for (const toolCall of msg.tool_calls) {
                    if (this._aborted) break;

                    // Guard: refuse to complete a mutation-required phase before any file
                    // has changed. Capped so a model that truly can't produce code still
                    // exits (to error) rather than looping forever.
                    if (toolCall.function.name === 'complete_phase' && this._mutationRequired
                        && this.prematureCompleteBlocks < MAX_PREMATURE_COMPLETE_BLOCKS) {
                        this.prematureCompleteBlocks++;
                        this._completePhaseAttempted = true;
                        this._emit('message', { content: `[guard] Blocked premature complete_phase in ${this.phaseName}: no files changed (${this.prematureCompleteBlocks}/${MAX_PREMATURE_COMPLETE_BLOCKS})`, turn: this.turnCount });
                        this.messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: `Refused: phase "${this.phaseName}" cannot complete because no files have been written. Call write_file with the actual implementation, then complete the phase. Do not set next_phase to "error" to skip the work.`,
                        });
                        continue;
                    }

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

                    // Track successful file mutations so mutation-required phases can complete.
                    // toolWriteFile returns "Written <n> bytes…"; toolEditFile returns "Edited …".
                    if ((toolCall.function.name === 'write_file' && output.startsWith('Written '))
                        || (toolCall.function.name === 'edit_file' && output.startsWith('Edited '))) {
                        this.mutationCount++;
                    }

                    // Track whether complete_phase was attempted but rejected —
                    // the nudge system uses this to avoid lying to the model.
                    if (toolCall.function.name === 'complete_phase' && !output.startsWith(PHASE_COMPLETE_SENTINEL)) {
                        this._completePhaseAttempted = true;
                    }

                    // Phase completed — stop the loop so the next phase starts with
                    // a fresh conversation context (new session, no stale tool history).
                    if (output.startsWith(PHASE_COMPLETE_SENTINEL)) {
                        const nextPhase = output.slice(PHASE_COMPLETE_SENTINEL.length).split('\n')[0];
                        this._emit('phase_complete', { nextPhase, turn: this.turnCount });
                        this._running = false;
                        this._phaseCompleted = true;
                        phaseCompleted = true;
                        break;
                    }
                }

                // Checkpoint after each complete tool round-trip
                this.onCheckpoint?.(compactForStorage(this.messages));

                if (phaseCompleted) break;
            }

            this._emit('complete', {
                turns: this.turnCount,
                aborted: this._aborted,
                sessionId: this.sessionId,
                usage: { input: this.usageInput, output: this.usageOutput },
            });
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
