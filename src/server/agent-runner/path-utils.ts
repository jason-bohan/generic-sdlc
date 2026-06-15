import { resolve, relative, sep } from 'path';
import { parseJsonUtf8File } from '../json-file';

/**
 * Resolve a user-supplied path relative to workspaceDir if relative,
 * or as-is if absolute, and verify it stays under one of the allowedRoots.
 *
 * Uses path.relative() rather than startsWith() to prevent sibling-path
 * escapes (e.g. /repos/workspace-evil matching root /repos/workspace).
 *
 * Returns { ok: true, resolved } or { ok: false, error }.
 */
export function safePath(
    inputPath: string,
    workspaceDir: string,
    allowedRoots: string[],
): { ok: true; resolved: string } | { ok: false; error: string } {
    const isAbsolute = /^[A-Za-z]:[/\\]/.test(inputPath) || inputPath.startsWith('/');
    const resolved = isAbsolute ? resolve(inputPath) : resolve(workspaceDir, inputPath);

    for (const root of allowedRoots) {
        const rel = relative(resolve(root), resolved);
        // rel that doesn't start with '..' means resolved is under root.
        // An empty rel means they are the same path — also allowed.
        // On Windows, cross-drive relative paths always start with '..', so this is safe.
        if (!rel.startsWith('..')) {
            return { ok: true, resolved };
        }
    }

    return {
        ok: false,
        error: `Path "${resolved}" is outside allowed roots: ${allowedRoots.join(', ')}. Use a relative path or a path within the workspace.`,
    };
}

/**
 * Resolve a path for WRITING with plumbing protection: agents may READ the framework
 * (skills, configs) but may not WRITE into it while working on a different target
 * project — they don't get to modify their own tooling (yet). When the framework IS
 * the active workspace (self-development), workspaceDir === frameworkDir and writes
 * are allowed normally.
 */
export function resolveWritablePath(
    inputPath: string,
    workspaceDir: string,
    frameworkDir: string,
): { ok: true; resolved: string } | { ok: false; error: string } {
    const check = safePath(inputPath, workspaceDir, [workspaceDir]);
    if (check.ok) return check;
    const intoFramework = safePath(inputPath, workspaceDir, [frameworkDir]);
    if (intoFramework.ok && resolve(frameworkDir) !== resolve(workspaceDir)) {
        return { ok: false, error: `writing into the SDLC framework (${frameworkDir}) is not allowed — agents may not modify their own tooling. Write only inside the target workspace: ${workspaceDir}` };
    }
    return check;
}

/**
 * Convert a simple glob pattern to a regex.
 * Supports **, *, ?, and {a,b} alternatives.
 */
export function globToRegex(pattern: string): RegExp {
    let escaped = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '{') {
            const end = pattern.indexOf('}', i);
            if (end !== -1) {
                const alts = pattern.slice(i + 1, end).split(',').map(a => globToRegex(a.trim()).source);
                escaped += `(?:${alts.join('|')})`;
                i = end + 1;
                continue;
            }
        }
        if (ch === '*' && pattern[i + 1] === '*') {
            // ** matches everything including path separators
            escaped += '.*';
            i += 2;
            // skip trailing slash if present
            if (pattern[i] === '/') i++;
            continue;
        }
        if (ch === '*') { escaped += '[^/]*'; i++; continue; }
        if (ch === '?') { escaped += '[^/]'; i++; continue; }
        if (ch === '.') { escaped += '\\.'; i++; continue; }
        escaped += ch;
        i++;
    }
    return new RegExp(`^${escaped}$`);
}

/** Read the agent's current phase from its status file. */
export function readAgentPhase(frameworkDir: string, agentId: string): string {
    try {
        const s = parseJsonUtf8File(resolve(frameworkDir, `.${agentId}-status.json`)) as { currentPhase?: string };
        return String(s.currentPhase ?? '');
    } catch { return ''; }
}
