import { existsSync } from 'fs';
import { resolve } from 'path';
import { AGENT_DISPLAY_NAME_DEFAULTS } from '../shared/agentDisplayDefaults';
import { parseJsonUtf8File } from './json-file';

/** Built-in defaults when `scheduler.agents.<id>.displayName` is unset. */
export const DEFAULT_AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = AGENT_DISPLAY_NAME_DEFAULTS;

/**
 * Dashboard label for an agent: config `displayName` if set, else default character name, else id.
 */
export function resolveAgentDisplayName(agentId: string, rootDir: string): string {
    const configFile = resolve(rootDir, '.sdlc-framework.config.json');
    if (existsSync(configFile)) {
        try {
            const cfg = parseJsonUtf8File(configFile) as {
                scheduler?: { agents?: Record<string, { displayName?: string }> };
            };
            const custom = cfg.scheduler?.agents?.[agentId]?.displayName;
            if (typeof custom === 'string' && custom.trim()) return custom.trim();
        } catch { /* use default */ }
    }
    return AGENT_DISPLAY_NAME_DEFAULTS[agentId] || agentId;
}
