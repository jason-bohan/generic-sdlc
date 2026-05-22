/** Shared execution-mode labels for TUI (dashboard / InteractiveView / CreateStoryView). */

export type ExecMode = 'local' | 'balanced' | 'speed';

export const MODE_LABELS: Record<ExecMode, string> = {
    local: 'Efficiency (Goose + Ollama)',
    balanced: 'Balanced (Ollama + API)',
    speed: 'Speed (Cloud AI — uses more tokens)',
};

/** One-line hint for which enrichment path runs when creating a story. */
export function enrichmentHint(mode: ExecMode): string {
    switch (mode) {
        case 'local':
            return 'Enrichment: Goose CLI + Ollama before Agility create';
        case 'balanced':
            return 'Enrichment: Ollama + API before Agility create';
        case 'speed':
            return 'Enrichment: none at create — expand fields via cloud agent after';
        default:
            return '';
    }
}

export function parseExecMode(raw: unknown): ExecMode | null {
    if (raw === 'local' || raw === 'balanced' || raw === 'speed') return raw;
    return null;
}
