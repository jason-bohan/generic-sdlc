export type DemoMode = 'standard' | 'financial';

export interface DemoModeInfo {
    mode: DemoMode;
    label: string;
    description: string;
}

export const DEMO_MODES: DemoModeInfo[] = [
    { mode: 'standard', label: 'Standard', description: 'General-purpose SDLC compliance' },
    { mode: 'financial', label: 'Financial', description: 'Financial services controls & risk' },
];

export function isValidDemoMode(val: unknown): val is DemoMode {
    return val === 'standard' || val === 'financial';
}

export const DEFAULT_DEMO_MODE: DemoMode = 'standard';
