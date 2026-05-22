import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import {
    getAgentStepModePhases,
    getStepModeTerminalPhases,
    isAgentStepMode,
    isAgentStepModePhase,
    isStepModePhase,
    STEP_MODE_PHASES,
} from '../server/stepMode';

const TMP = resolve(__dirname, '.stepmode-test-tmp');
const CONFIG = resolve(TMP, '.sdlc-framework.config.json');

function writeConfig(cfg: object) {
    writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
});

describe('isAgentStepMode', () => {
    it('returns false when config file does not exist', () => {
        expect(isAgentStepMode('frontend', resolve(TMP, 'missing.json'))).toBe(false);
    });

    it('returns false when stepMode is not set', () => {
        writeConfig({
            scheduler: { agents: { frontend: { enabled: true } } },
        });
        expect(isAgentStepMode('frontend', CONFIG)).toBe(false);
    });

    it('returns false when stepMode is explicitly false', () => {
        writeConfig({
            scheduler: { agents: { frontend: { enabled: true, stepMode: false } } },
        });
        expect(isAgentStepMode('frontend', CONFIG)).toBe(false);
    });

    it('returns true when stepMode is true', () => {
        writeConfig({
            scheduler: { agents: { frontend: { enabled: true, stepMode: true } } },
        });
        expect(isAgentStepMode('frontend', CONFIG)).toBe(true);
    });

    it('returns correct value per agent', () => {
        writeConfig({
            scheduler: {
                agents: {
                    frontend: { stepMode: true },
                    reviewer: { stepMode: false },
                    devops: { stepMode: true },
                },
            },
        });
        expect(isAgentStepMode('frontend', CONFIG)).toBe(true);
        expect(isAgentStepMode('reviewer', CONFIG)).toBe(false);
        expect(isAgentStepMode('devops', CONFIG)).toBe(true);
    });

    it('returns false for unknown agent', () => {
        writeConfig({
            scheduler: { agents: { frontend: { stepMode: true } } },
        });
        expect(isAgentStepMode('qa', CONFIG)).toBe(false);
    });

    it('returns false when scheduler section is missing', () => {
        writeConfig({ executionMode: 'speed' });
        expect(isAgentStepMode('frontend', CONFIG)).toBe(false);
    });

    it('returns false for malformed JSON', () => {
        writeFileSync(CONFIG, 'not valid json');
        expect(isAgentStepMode('frontend', CONFIG)).toBe(false);
    });
});

describe('isStepModePhase', () => {
    it('recognizes analyzing as the phase-1 step-mode pause', () => {
        expect(isStepModePhase('analyzing')).toBe(true);
    });

    it('recognizes validating as a step-mode phase', () => {
        expect(isStepModePhase('validating')).toBe(true);
    });

    it('does not treat other phases as step-mode phases', () => {
        expect(isStepModePhase('idle')).toBe(false);
        expect(isStepModePhase('planning')).toBe(false);
        expect(isStepModePhase('generating-code')).toBe(false);
        expect(isStepModePhase('creating-pr')).toBe(false);
        expect(isStepModePhase('watching-reviews')).toBe(false);
        expect(isStepModePhase('complete')).toBe(false);
    });
});

describe('getStepModeTerminalPhases', () => {
    const BASE_TERMINALS = ['complete', 'idle', 'watching-reviews', 'pending-approval'];

    it('appends legacy default step-mode phases when no agent is provided', () => {
        const extended = getStepModeTerminalPhases(BASE_TERMINALS);
        expect(extended).toContain('complete');
        expect(extended).toContain('idle');
        expect(extended).toContain('watching-reviews');
        expect(extended).toContain('pending-approval');
        expect(extended).toContain('analyzing');
        expect(extended).toContain('validating');
    });

    it('does not modify the original array', () => {
        const original = [...BASE_TERMINALS];
        getStepModeTerminalPhases(BASE_TERMINALS);
        expect(BASE_TERMINALS).toEqual(original);
    });

    it('exports the correct step-mode phases', () => {
        expect(STEP_MODE_PHASES).toEqual(['analyzing', 'validating']);
    });

    it('uses Frontend-specific pause phases when an agent is provided', () => {
        const extended = getStepModeTerminalPhases(BASE_TERMINALS, 'frontend');
        expect(extended).toContain('analyzing');
        expect(extended).toContain('generating-code');
        expect(extended).toContain('validating');
        expect(extended).toContain('creating-pr');
        expect(extended).toContain('watching-reviews');
        expect(extended).toContain('addressing-feedback');
        expect(extended).toContain('running-cypress');
    });

    it('reads per-agent pause phase overrides from config', () => {
        writeConfig({
            scheduler: {
                agents: {
                    frontend: {
                        stepMode: true,
                        stepModePhases: ['planning', 'validating'],
                    },
                },
            },
        });

        expect(getAgentStepModePhases('frontend', CONFIG)).toEqual(['planning', 'validating']);
        expect(isAgentStepModePhase('frontend', 'planning', CONFIG)).toBe(true);
        expect(isAgentStepModePhase('frontend', 'analyzing', CONFIG)).toBe(false);
        expect(getStepModeTerminalPhases(BASE_TERMINALS, 'frontend', CONFIG)).toContain('planning');
    });
});

describe('step mode and handoffs', () => {
    it('step-mode agent should prevent downstream spawns (integration scenario)', () => {
        writeConfig({
            scheduler: {
                agents: {
                    frontend: { enabled: true, stepMode: true },
                    reviewer: { enabled: true, stepMode: false },
                    devops: { enabled: true, stepMode: false },
                },
            },
        });

        expect(isAgentStepMode('frontend', CONFIG)).toBe(true);
        expect(isAgentStepMode('reviewer', CONFIG)).toBe(false);
        expect(isAgentStepMode('devops', CONFIG)).toBe(false);
    });

    it('non-step-mode agent allows handoffs (integration scenario)', () => {
        writeConfig({
            scheduler: {
                agents: {
                    frontend: { enabled: true, stepMode: false },
                },
            },
        });

        expect(isAgentStepMode('frontend', CONFIG)).toBe(false);
    });

    it('step mode can be toggled by rewriting config', () => {
        writeConfig({
            scheduler: { agents: { frontend: { stepMode: false } } },
        });
        expect(isAgentStepMode('frontend', CONFIG)).toBe(false);

        writeConfig({
            scheduler: { agents: { frontend: { stepMode: true } } },
        });
        expect(isAgentStepMode('frontend', CONFIG)).toBe(true);
    });
});
