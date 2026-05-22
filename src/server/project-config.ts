import { existsSync } from 'fs';
import { resolve } from 'path';
import { parseJsonUtf8File } from './json-file';

export interface ProjectProfile {
    organization: string;
    azureProject: string;
    repositoryId: string;
    targetBranch: string;
    pipelineId: number;
    reviewerIds: string[];
    branchPattern: string;
    /** Maps Agility team OID (e.g. "Team:2001") to branch prefix (e.g. "chipmunks/") */
    teamPrefixes: Record<string, string>;
    /**
     * Named dev-site environments for branch naming (e.g. "Alvin", "Donatello").
     * When present, the "Pick Up Story" flow shows an environment picker.
     * Maps to the {env} placeholder in branchPattern.
     */
    environments?: string[];
    /** Absolute path to the repo workspace for this project (used by the agent driver) */
    workspacePath?: string;
    prUrlBase?: string;
    scope?: string;
    team?: string;
    owners?: string[];
}

interface LegacyProjectConfig {
    organization?: string;
    azureProject?: string;
    repositoryId?: string;
    prUrlBase?: string;
    scope?: string;
    team?: string;
    owners?: string[];
}

const DEFAULT_PROFILE: ProjectProfile = {
    organization: '',
    azureProject: '',
    repositoryId: '',
    targetBranch: 'main',
    pipelineId: 646,
    reviewerIds: [],
    branchPattern: 'feat/{storyNumber}-{slug}',
    teamPrefixes: {} };

/**
 * Read the active project profile from config.
 * Supports both the new `projects` section and the legacy `project` section.
 */
export function getActiveProject(configPath: string): ProjectProfile {
    return getProjectProfile(configPath);
}

/**
 * Read a named project profile from config, or the active profile when no name is provided.
 * Supports both the new `projects` section and the legacy `project` section.
 */
export function getProjectProfile(configPath: string, projectName?: string): ProjectProfile {
    if (!existsSync(configPath)) return { ...DEFAULT_PROFILE };

    try {
        const cfg = parseJsonUtf8File(configPath);

        if (cfg.projects && typeof cfg.projects === 'object') {
            const activeKey =
                projectName && cfg.projects[projectName]
                    ? projectName
                    : cfg.activeProject || Object.keys(cfg.projects)[0];
            const profile = cfg.projects[activeKey];
            if (profile) {
                return {
                    ...DEFAULT_PROFILE,
                    ...profile,
                    teamPrefixes: profile.teamPrefixes || {},
                    reviewerIds: Array.isArray(profile.reviewerIds) ? profile.reviewerIds : [] };
            }
        }

        // Legacy fallback: build profile from the flat `project` section
        const legacy: LegacyProjectConfig = cfg.project || {};
        return {
            ...DEFAULT_PROFILE,
            organization: legacy.organization || '',
            azureProject: legacy.azureProject || '',
            repositoryId: legacy.repositoryId || '',
            prUrlBase: legacy.prUrlBase || '',
            scope: legacy.scope,
            team: legacy.team,
            owners: legacy.owners };
    } catch {
        return { ...DEFAULT_PROFILE };
    }
}

/**
 * Get the name of the active project profile (for display in the UI).
 */
export function getActiveProjectName(configPath: string): string {
    if (!existsSync(configPath)) return 'default';
    try {
        const cfg = parseJsonUtf8File(configPath);
        if (cfg.projects && typeof cfg.projects === 'object') {
            return cfg.activeProject || Object.keys(cfg.projects)[0] || 'default';
        }
        return 'default';
    } catch {
        return 'default';
    }
}

/**
 * List all available project profile names.
 */
export function listProjectNames(configPath: string): string[] {
    if (!existsSync(configPath)) return [];
    try {
        const cfg = parseJsonUtf8File(configPath);
        if (cfg.projects && typeof cfg.projects === 'object') {
            return Object.keys(cfg.projects);
        }
        return [];
    } catch {
        return [];
    }
}

/**
 * Build a branch name from a project profile's pattern.
 *
 * Supported placeholders:
 *   {teamPrefix}   — resolved from profile.teamPrefixes[teamId], empty if not found
 *   {env}          — dev-site environment name, lowercased (e.g. "donatello")
 *   {storyNumber}  — lowercased story number (e.g. "b-17010")
 *   {slug}         — sanitized story name
 */
export function resolveProjectBranch(
    profile: ProjectProfile,
    storyNumber: string,
    storyName: string,
    teamId?: string,
    environment?: string,
): string {
    const teamPrefix = (teamId && profile.teamPrefixes[teamId]) || '';
    const lowerStory = storyNumber.toLowerCase();
    const env = (environment || '').toLowerCase();

    const separator = profile.branchPattern.includes('{storyNumber}_{slug}') ? '_' : '-';
    const slug = (storyName || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, separator)
        .slice(0, 40)
        .replace(new RegExp(`${separator === '_' ? '_' : '-'}$`), '');

    let branch = profile.branchPattern
        .replace('{teamPrefix}', teamPrefix)
        .replace('{env}', env)
        .replace('{storyNumber}', lowerStory)
        .replace('{slug}', slug || 'implementation');

    branch = branch.replace(/\/{2,}/g, '/');
    branch = branch.replace(/^\/+/, '');

    return branch;
}

/**
 * Return the full git ref for the project's target branch.
 */
export function resolveTargetRef(profile: ProjectProfile): string {
    return `refs/heads/${profile.targetBranch}`;
}
