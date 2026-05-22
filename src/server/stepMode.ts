import { existsSync } from 'fs';
import { DEFAULT_STEP_MODE_PHASES, getDefaultStepModePhases, normalizeStepModePhases } from '../shared/agentPhases';
import { parseJsonUtf8File } from './json-file';

export const STEP_MODE_PHASES = DEFAULT_STEP_MODE_PHASES;
export type StepModePhase = typeof STEP_MODE_PHASES[number];

export function isGlobalStepMode(configPath: string): boolean {
    if (!existsSync(configPath)) return false;
    try {
        const cfg = parseJsonUtf8File(configPath);
        return cfg.scheduler?.globalStepMode === true;
    } catch {
        return false;
    }
}

export function isAgentStepMode(agentId: string, configPath: string): boolean {
    if (!existsSync(configPath)) return false;
    try {
        const cfg = parseJsonUtf8File(configPath);
        if (cfg.scheduler?.globalStepMode === true) return true;
        return cfg.scheduler?.agents?.[agentId]?.stepMode === true;
    } catch {
        return false;
    }
}

export function isStepModePhase(phase: string): boolean {
    return (STEP_MODE_PHASES as readonly string[]).includes(phase);
}

export function getAgentStepModePhases(agentId: string, configPath?: string): string[] {
    if (configPath && existsSync(configPath)) {
        try {
            const cfg = parseJsonUtf8File(configPath);
            const configured = normalizeStepModePhases(cfg.scheduler?.agents?.[agentId]?.stepModePhases);
            if (configured) return configured;
        } catch {
            // Fall back to defaults.
        }
    }
    return [...getDefaultStepModePhases(agentId)];
}

export function isAgentStepModePhase(agentId: string, phase: string, configPath?: string): boolean {
    return getAgentStepModePhases(agentId, configPath).includes(phase);
}

export function getStepModeTerminalPhases(baseTerminalPhases: string[], agentId?: string, configPath?: string): string[] {
    const phases = agentId ? getAgentStepModePhases(agentId, configPath) : [...STEP_MODE_PHASES];
    return [...new Set([...baseTerminalPhases, ...phases])];
}
