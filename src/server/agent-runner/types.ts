export interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export interface CompletionResponse {
    message: Message;
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
}

export interface ProviderConfig {
    baseUrl: string;
    model: string;
    apiKey?: string;
    maxTokens?: number;
    temperature?: number;
}

export type RunnerEventType =
    | 'start'
    | 'tool_call'
    | 'tool_result'
    | 'message'
    | 'injection'
    | 'phase_complete'
    | 'complete'
    | 'error';

export interface RunnerEvent {
    type: RunnerEventType;
    agentId: string;
    timestamp: string;
    data?: unknown;
}
