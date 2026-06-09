import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, normalize } from 'path';

export interface WorkspaceConfig {
    workspaces: Record<string, string>;
    project?: { team?: string; owners?: string[]; ownersLastFirst?: string[]; [k: string]: unknown };
    scheduler: { agents: Record<string, { enabled: boolean }> };
}

export const API_BASE = 'http://localhost:3847';

const SDLC_FRAMEWORK_HOME = process.env.SDLC_FRAMEWORK_HOME ?? process.cwd();
const CONFIG_FILE = '.sdlc-framework.config.json';

export const PHASE_COLORS: Record<string, string> = {
    idle: 'gray',
    'pending-approval': 'yellow',
    'reading-story': 'cyan',
    planning: 'cyan',
    'creating-tasks': 'cyan',
    analyzing: 'blue',
    'generating-code': 'magenta',
    validating: 'yellow',
    'creating-pr': 'blue',
    'watching-reviews': 'yellow',
    'addressing-feedback': 'magenta',
    'running-cypress': 'yellow',
    complete: 'green',
    error: 'red',
    'pending-review': 'yellow',
    reviewing: 'cyan',
    commenting: 'cyan',
    approved: 'green',
    'changes-requested': 'red',
    'waiting-for-fixes': 'yellow',
    'pending-build': 'yellow',
    'monitoring-build': 'blue',
    'build-passed': 'green',
    'build-failed': 'red',
    researching: 'blue',
    designing: 'magenta',
    'spec-ready': 'green',
    collaborating: 'cyan',
};

export function loadConfig(): WorkspaceConfig | null {
    const configPath = resolve(SDLC_FRAMEWORK_HOME, CONFIG_FILE);
    if (!existsSync(configPath)) return null;
    try {
        return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
        return null;
    }
}

export async function checkServer(): Promise<boolean> {
    try {
        const res = await fetch(`${API_BASE}/api/execution-mode`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    } catch {
        return false;
    }
}

function normalizePath(p: string): string {
    return normalize(p).toLowerCase().replace(/[\\/]+$/, '');
}

export function resolveAgent(dir: string): string | null {
    const config = loadConfig();
    if (!config?.workspaces) return null;

    const normalizedDir = normalizePath(dir);
    for (const [workspace, agent] of Object.entries(config.workspaces)) {
        if (normalizePath(workspace) === normalizedDir) {
            return agent;
        }
    }
    return null;
}

export function resolveWorkspaceForAgent(agentName: string): string | null {
    const config = loadConfig();
    if (!config?.workspaces) return null;

    for (const [workspace, agent] of Object.entries(config.workspaces)) {
        if (agent === agentName) return workspace;
    }
    return null;
}

export function getEnabledAgents(): string[] {
    const config = loadConfig();
    if (!config?.scheduler?.agents) return [];
    return Object.entries(config.scheduler.agents)
        .filter(([_, cfg]) => cfg.enabled !== false)
        .map(([name]) => name);
}

export function discoverAgentsFromStatusFiles(dir: string): string[] {
    const targetDir = resolve(dir);
    if (!existsSync(targetDir)) return [];
    try {
        const files = readdirSync(targetDir);
        const agents: string[] = [];
        const pattern = /^\.([a-z]+)-status\.json$/;
        for (const f of files) {
            const match = f.match(pattern);
            if (match) agents.push(match[1]);
        }
        return agents.sort();
    } catch {
        return [];
    }
}

export function getSDLCFrameworkHome(): string {
    return SDLC_FRAMEWORK_HOME;
}
