import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Returns a preamble that tells agents which context files to read before acting.
 * Agents should append significant decisions back to context/active-work.md.
 */
export function buildContextPreamble(rootDir: string): string {
    const files: string[] = [];
    if (existsSync(resolve(rootDir, 'context/bootstrap.md'))) files.push('context/bootstrap.md');
    if (existsSync(resolve(rootDir, 'context/active-work.md'))) files.push('context/active-work.md');
    if (files.length === 0) return '';
    return `First read ${files.join(' and ')} for project context. Append significant decisions or blockers to context/active-work.md. `;
}
