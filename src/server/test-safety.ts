import { existsSync } from 'fs';
import { isMockExternalMode } from './external-mode';
import { parseJsonUtf8File } from './json-file';

export function isAzureDevOpsUrl(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    return /https?:\/\/(?:dev\.azure\.com|[^/\s]+\.visualstudio\.com)\//i.test(value);
}

export function getMockModeSafetyDirective(configPath: string): string {
    if (!isMockExternalMode(configPath)) return '';
    return [
        '',
        'MOCK EXTERNAL MODE IS ACTIVE.',
        'Hard safety rule: do not call Azure DevOps MCP tools, do not run git push, and do not create, update, approve, queue, or complete real Azure DevOps PRs or pipelines.',
        'Use local git branches and commits only. For Agility MCP calls, use the local mock base URL http://localhost:3001/mock-v1 with AGILITY_API_KEY=mock-token.',
        'When you reach PR/build/review phases, simulate them through SDLC Framework mock status/API state instead of contacting Azure DevOps.',
    ].join('\n');
}

export function readExternalMode(configPath: string): 'live' | 'mock' {
    return isMockExternalMode(configPath) ? 'mock' : 'live';
}

export function hasLiveAdoCredentialsInMockMode(configPath: string): boolean {
    if (!isMockExternalMode(configPath)) return false;
    if (process.env.AZURE_DEVOPS_PAT || process.env.AZURE_DEVOPS_EXT_PAT || process.env.VSS_PAT) return true;
    if (!existsSync(configPath)) return false;
    try {
        const cfg = parseJsonUtf8File(configPath);
        return Object.values(cfg.scheduler?.agents ?? {}).some((agent: any) => typeof agent?.adoPat === 'string' && agent.adoPat.trim());
    } catch {
        return false;
    }
}
