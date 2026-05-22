import { existsSync, writeFileSync } from 'node:fs';
import { parseJsonUtf8File } from './json-file';

export interface AiProviderPolicy {
    enabled: boolean;
}

export function isCursorAiEnabled(configPath: string): boolean {
    if (process.env.SDLC_FRAMEWORK_CURSOR_AI === '0') return false;
    if (!existsSync(configPath)) return false;
    try {
        const cfg = parseJsonUtf8File(configPath) as Record<string, any>;
        if (typeof cfg.cursorAiEnabled === 'boolean') return cfg.cursorAiEnabled;
        if (typeof cfg.ai?.cursorAiEnabled === 'boolean') return cfg.ai.cursorAiEnabled;
        return false;
    } catch {
        return false;
    }
}

export function setCursorAiEnabled(configPath: string, enabled: boolean): AiProviderPolicy {
    const cfg = existsSync(configPath) ? parseJsonUtf8File(configPath) as Record<string, any> : {};
    cfg.cursorAiEnabled = enabled;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    return { enabled };
}

export function isClaudeEnabled(configPath: string): boolean {
    if (process.env.SDLC_FRAMEWORK_CLAUDE_AI === '0') return false;
    if (!existsSync(configPath)) return false;
    try {
        const cfg = parseJsonUtf8File(configPath) as Record<string, any>;
        if (typeof cfg.claudeAiEnabled === 'boolean') return cfg.claudeAiEnabled;
        return false;
    } catch {
        return false;
    }
}

export function setClaudeEnabled(configPath: string, enabled: boolean): AiProviderPolicy {
    const cfg = existsSync(configPath) ? parseJsonUtf8File(configPath) as Record<string, any> : {};
    cfg.claudeAiEnabled = enabled;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    return { enabled };
}

