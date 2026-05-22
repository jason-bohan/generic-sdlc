import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import {
    getActiveProject,
    getActiveProjectName,
    getProjectProfile,
    listProjectNames,
    resolveProjectBranch,
    resolveTargetRef,
    type ProjectProfile,
} from '../server/project-config';

const TMP_DIR = resolve(tmpdir(), `sdlc-framework-test-${Date.now()}`);
const CONFIG_PATH = join(TMP_DIR, '.sdlc-framework.config.json');

function writeConfig(obj: unknown) {
    writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2));
}

const SDLC_FRAMEWORK_PROFILE: ProjectProfile = {
    organization: 'yourcompany',
    azureProject: 'YourProject',
    repositoryId: 'SDLC Framework',
    targetBranch: 'main',
    pipelineId: 646,
    reviewerIds: ['abc-123'],
    branchPattern: 'feat/{storyNumber}-{slug}',
    teamPrefixes: {},
};

const SECONDARY_PROFILE: ProjectProfile = {
    organization: 'yourcompany',
    azureProject: 'YourProject',
    repositoryId: 'c268771c-65f3-43e4-a9d5-adfc4267c47d',
    targetBranch: 'master',
    pipelineId: 350,
    reviewerIds: ['xyz-456'],
    branchPattern: '{teamPrefix}{env}/{storyNumber}_{slug}',
    teamPrefixes: {
        'Team:2001': 'chipmunks/',
        'Team:2002': 'ninjas/',
    },
    environments: ['Alvin', 'Dale', 'Donatello', 'Gadget', 'Krang'],
};

beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('getActiveProject', () => {
    it('returns defaults when config file does not exist', () => {
        const profile = getActiveProject('/nonexistent/path/.sdlc-framework.config.json');
        expect(profile.targetBranch).toBe('main');
        expect(profile.branchPattern).toBe('feat/{storyNumber}-{slug}');
    });

    it('loads from projects section using activeProject key', () => {
        writeConfig({
            activeProject: 'YourProject',
            projects: { 'sdlc-framework': SDLC_FRAMEWORK_PROFILE, YourProject: SECONDARY_PROFILE },
        });
        const profile = getActiveProject(CONFIG_PATH);
        expect(profile.targetBranch).toBe('master');
        expect(profile.pipelineId).toBe(350);
        expect(profile.repositoryId).toBe('c268771c-65f3-43e4-a9d5-adfc4267c47d');
        expect(profile.teamPrefixes['Team:2001']).toBe('chipmunks/');
    });

    it('falls back to first project if activeProject key is missing', () => {
        writeConfig({
            projects: { 'sdlc-framework': SDLC_FRAMEWORK_PROFILE, YourProject: SECONDARY_PROFILE },
        });
        const profile = getActiveProject(CONFIG_PATH);
        expect(profile.targetBranch).toBe('main');
        expect(profile.pipelineId).toBe(646);
    });

    it('falls back to legacy project section when no projects section exists', () => {
        writeConfig({
            project: {
                organization: 'legacy-org',
                azureProject: 'LegacyProj',
                repositoryId: 'LegacyRepo',
                prUrlBase: 'https://example.com/pr',
            },
        });
        const profile = getActiveProject(CONFIG_PATH);
        expect(profile.organization).toBe('legacy-org');
        expect(profile.repositoryId).toBe('LegacyRepo');
        expect(profile.targetBranch).toBe('main');
        expect(profile.branchPattern).toBe('feat/{storyNumber}-{slug}');
    });
});

describe('getProjectProfile', () => {
    it('loads a named project even when another project is active', () => {
        writeConfig({
            activeProject: 'sdlc-framework',
            projects: { 'sdlc-framework': SDLC_FRAMEWORK_PROFILE, YourProject: SECONDARY_PROFILE },
        });
        const profile = getProjectProfile(CONFIG_PATH, 'YourProject');
        expect(profile.targetBranch).toBe('master');
        expect(profile.pipelineId).toBe(350);
    });

    it('falls back to the active project when the named project is unknown', () => {
        writeConfig({
            activeProject: 'YourProject',
            projects: { 'sdlc-framework': SDLC_FRAMEWORK_PROFILE, YourProject: SECONDARY_PROFILE },
        });
        const profile = getProjectProfile(CONFIG_PATH, 'unknown');
        expect(profile.targetBranch).toBe('master');
    });
});

describe('getActiveProjectName', () => {
    it('returns default for missing file', () => {
        expect(getActiveProjectName('/nope')).toBe('default');
    });

    it('returns activeProject key from config', () => {
        writeConfig({
            activeProject: 'YourProject',
            projects: { 'sdlc-framework': SDLC_FRAMEWORK_PROFILE, YourProject: SECONDARY_PROFILE },
        });
        expect(getActiveProjectName(CONFIG_PATH)).toBe('YourProject');
    });
});

describe('listProjectNames', () => {
    it('returns empty for missing file', () => {
        expect(listProjectNames('/nope')).toEqual([]);
    });

    it('returns all project keys', () => {
        writeConfig({
            projects: { 'sdlc-framework': SDLC_FRAMEWORK_PROFILE, YourProject: SECONDARY_PROFILE },
        });
        expect(listProjectNames(CONFIG_PATH)).toEqual(['sdlc-framework', 'YourProject']);
    });
});

describe('resolveProjectBranch', () => {
    it('builds SDLC Framework-style branch: feat/<storyNumber>-<slug>', () => {
        const branch = resolveProjectBranch(SDLC_FRAMEWORK_PROFILE, 'B-17010', 'Add dark mode toggle');
        expect(branch).toBe('feat/b-17010-add-dark-mode-toggle');
    });

    it('handles empty story name', () => {
        const branch = resolveProjectBranch(SDLC_FRAMEWORK_PROFILE, 'B-17010', '');
        expect(branch).toBe('feat/b-17010-implementation');
    });

    it('builds YourProject-style branch: team/env/storyNumber_slug', () => {
        const branch = resolveProjectBranch(SECONDARY_PROFILE, 'B-17010', 'Add dark mode toggle', 'Team:2001', 'Donatello');
        expect(branch).toBe('chipmunks/donatello/b-17010_add_dark_mode_toggle');
    });

    it('builds YourProject-style without env when not provided', () => {
        const branch = resolveProjectBranch(SECONDARY_PROFILE, 'B-17010', 'Fix header layout', 'Team:2002');
        expect(branch).toBe('ninjas/b-17010_fix_header_layout');
    });

    it('builds YourProject-style without team prefix when teamId is unknown', () => {
        const branch = resolveProjectBranch(SECONDARY_PROFILE, 'B-17010', 'Fix header layout', undefined, 'Gadget');
        expect(branch).toBe('gadget/b-17010_fix_header_layout');
    });

    it('truncates long slugs to 40 chars', () => {
        const longName = 'a'.repeat(80);
        const branch = resolveProjectBranch(SDLC_FRAMEWORK_PROFILE, 'B-17010', longName);
        const slugPart = branch.replace('feat/b-17010-', '');
        expect(slugPart.length).toBeLessThanOrEqual(40);
    });
});

describe('resolveTargetRef', () => {
    it('returns refs/heads/main for SDLC Framework', () => {
        expect(resolveTargetRef(SDLC_FRAMEWORK_PROFILE)).toBe('refs/heads/main');
    });

    it('returns refs/heads/master for YourProject', () => {
        expect(resolveTargetRef(SECONDARY_PROFILE)).toBe('refs/heads/master');
    });
});
