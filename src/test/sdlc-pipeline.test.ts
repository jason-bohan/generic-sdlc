import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { resolve } from 'path';
import {
    findStoryOwnerByPrId,
    applyReviewComplete,
    applyBuildComplete,
    applyDesignReady,
} from '../server/handoff';

const TMP = resolve(__dirname, '.sdlc-pipeline-tmp');

function writeJson(name: string, data: object) {
    writeFileSync(resolve(TMP, name), JSON.stringify(data, null, 2));
}

function readJson(name: string) {
    return JSON.parse(readFileSync(resolve(TMP, name), 'utf-8'));
}

beforeEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
});

describe('SDLC Pipeline — full handoff chain', () => {
    const TEST_PR = 55555;
    const TEST_STORY = 'B-10000';
    const TEST_BRANCH = 'feat/sdlc-test';

    function setupFrontendWithPR() {
        writeJson('.frontend-status.json', {
            storyNumber: TEST_STORY,
            storyName: 'SDLC Test Story',
            currentPhase: 'watching-reviews',
            prs: [{ id: TEST_PR, title: 'SDLC test PR', status: 'active', url: 'https://example.com/pr/55555' }],
            events: [],
        });
    }

    function setupReviewerWithPR() {
        writeJson('.reviewer-status.json', {
            assignedPR: {
                id: TEST_PR,
                title: 'SDLC test PR',
                url: 'https://example.com/pr/55555',
                storyNumber: TEST_STORY,
                branch: TEST_BRANCH,
            },
            currentPhase: 'pending-review',
            requestedAt: new Date().toISOString(),
            events: [{ timestamp: new Date().toISOString(), type: 'info', message: `PR #${TEST_PR} assigned` }],
        });
    }

    it('walks the full happy path: PR created → reviewer approves → DevOps build passes', () => {
        setupFrontendWithPR();
        setupReviewerWithPR();

        // Step 1: Reviewer approves → DevOps gets pending-build
        const reviewResult = applyReviewComplete(TMP, {
            prId: TEST_PR,
            verdict: 'approved',
            storyNumber: TEST_STORY,
            branch: TEST_BRANCH,
        });
        expect(reviewResult.ok).toBe(true);
        expect(reviewResult.target).toBe('devops');
        expect(reviewResult.targetPhase).toBe('pending-build');

        const devops = readJson('.devops-status.json');
        expect(devops.currentPhase).toBe('pending-build');
        expect(devops.assignedPR.id).toBe(TEST_PR);
        expect(devops.assignedPR.title).toBe('SDLC test PR');
        expect(devops.assignedPR.storyNumber).toBe(TEST_STORY);
        expect(devops.assignedPR.branch).toBe(TEST_BRANCH);
        expect(devops.events.length).toBeGreaterThan(0);

        // Reviewer stays in watching-build until CI completes, then applyBuildComplete resets to idle
        const reviewer = readJson('.reviewer-status.json');
        expect(reviewer.currentPhase).toBe('watching-build');
        expect(reviewer.handoffDispatched).toBe(true);
        const approvalEvent = reviewer.events.find((e: { message: string }) => e.message.includes('approved'));
        expect(approvalEvent).toBeDefined();

        // Step 2: Build passes → frontend PR completed, DevOps build-passed
        const buildResult = applyBuildComplete(TMP, {
            prId: TEST_PR,
            result: 'passed',
            buildId: 42,
        });
        expect(buildResult.ok).toBe(true);
        expect(buildResult.storyOwner).toBe('frontend');
        expect(buildResult.newPrStatus).toBe('completed');

        const frontendAfter = readJson('.frontend-status.json');
        expect(frontendAfter.prs[0].status).toBe('completed');

        const devopsAfter = readJson('.devops-status.json');
        expect(devopsAfter.currentPhase).toBe('build-passed');
        const buildEvent = devopsAfter.events.find((e: { message: string }) => e.message.includes('#42'));
        expect(buildEvent).toBeDefined();
    });

    it('walks the changes-requested path: reviewer rejects → owner PR marked', () => {
        setupFrontendWithPR();

        const result = applyReviewComplete(TMP, {
            prId: TEST_PR,
            verdict: 'changes-requested',
        });
        expect(result.ok).toBe(true);
        expect(result.target).toBe('frontend');
        expect(result.targetPhase).toBe('addressing-feedback');

        const frontend = readJson('.frontend-status.json');
        expect(frontend.prs[0].status).toBe('changes-requested');

        // DevOps should NOT be created for changes-requested
        expect(existsSync(resolve(TMP, '.devops-status.json'))).toBe(false);
    });

    it('walks the build-failed path: DevOps → build failed → owner PR marked', () => {
        setupFrontendWithPR();
        setupReviewerWithPR();

        // Approve first to get DevOps set up
        applyReviewComplete(TMP, { prId: TEST_PR, verdict: 'approved', storyNumber: TEST_STORY });

        // Build fails
        const result = applyBuildComplete(TMP, {
            prId: TEST_PR,
            result: 'failed',
            buildId: 99,
        });
        expect(result.ok).toBe(true);
        expect(result.newPrStatus).toBe('changes-requested');

        const frontend = readJson('.frontend-status.json');
        expect(frontend.prs[0].status).toBe('changes-requested');

        const devops = readJson('.devops-status.json');
        expect(devops.currentPhase).toBe('build-failed');
    });
});

describe('SDLC Pipeline — design handoff', () => {
    it('UX design-ready → target gets pending-approval, UX gets collaborating', () => {
        writeJson('.ux-status.json', {
            storyNumber: 'B-20000',
            storyName: 'Design Story',
            currentPhase: 'spec-ready',
            events: [],
        });

        const result = applyDesignReady(TMP, {
            storyNumber: 'B-20000',
            storyName: 'Design Story',
            designSpec: '.ux-design-spec.md',
            targetAgent: 'frontend',
            execMode: 'balanced',
        });

        expect(result.ok).toBe(true);
        expect(result.targetAgent).toBe('frontend');
        expect(result.targetPhase).toBe('pending-approval');

        const frontend = readJson('.frontend-status.json');
        expect(frontend.storyNumber).toBe('B-20000');
        expect(frontend.currentPhase).toBe('pending-approval');
        expect(frontend.collaborators).toContain('ux');
        expect(frontend.designSpec).toBe('.ux-design-spec.md');
        expect(frontend.executionMode).toBe('balanced');

        const ux = readJson('.ux-status.json');
        expect(ux.currentPhase).toBe('collaborating');
        expect(ux.collaborators).toContain('frontend');
    });

    it('design-ready to non-default agent (devops)', () => {
        const result = applyDesignReady(TMP, {
            storyNumber: 'B-30000',
            targetAgent: 'devops',
        });

        expect(result.targetAgent).toBe('devops');
        const devops = readJson('.devops-status.json');
        expect(devops.storyNumber).toBe('B-30000');
        expect(devops.collaborators).toContain('ux');
    });

    it('UX design-ready with autonomous workflow starts target immediately', () => {
        writeJson('.ux-status.json', {
            storyNumber: 'B-21000',
            storyName: 'Auto Spec',
            currentPhase: 'spec-ready',
            events: [],
        });

        const result = applyDesignReady(TMP, {
            storyNumber: 'B-21000',
            storyName: 'Auto Spec',
            designSpec: '.spec.md',
            targetAgent: 'frontend',
            execMode: 'speed',
            workflowMode: 'autonomous',
        });

        expect(result.targetPhase).toBe('reading-story');
        const frontend = readJson('.frontend-status.json');
        expect(frontend.currentPhase).toBe('reading-story');
        expect(frontend.executionMode).toBe('speed');
    });
});

describe('SDLC Pipeline — idempotency', () => {
    it('duplicate approval does not overwrite DevOps status', () => {
        writeJson('.devops-status.json', {
            currentPhase: 'pending-build',
            assignedPR: { id: 11111 },
            events: [{ timestamp: 'original', type: 'info', message: 'first write' }],
        });

        applyReviewComplete(TMP, { prId: 11111, verdict: 'approved' });

        const devops = readJson('.devops-status.json');
        expect(devops.events[0].message).toBe('first write');
        expect(devops.events).toHaveLength(1);
    });

    it('duplicate build-complete does not re-append events', () => {
        writeJson('.devops-status.json', {
            currentPhase: 'build-passed',
            events: [{ timestamp: 'x', type: 'success', message: 'already passed' }],
        });

        applyBuildComplete(TMP, { prId: 22222, result: 'passed' });

        const devops = readJson('.devops-status.json');
        expect(devops.events).toHaveLength(1);
    });

    it('duplicate design-ready does not overwrite if collaborator already set', () => {
        writeJson('.frontend-status.json', {
            storyNumber: 'B-40000',
            currentPhase: 'reading-story',
            collaborators: ['ux'],
            events: [{ timestamp: 'orig', type: 'info', message: 'original' }],
        });

        applyDesignReady(TMP, { storyNumber: 'B-40000' });

        const frontend = readJson('.frontend-status.json');
        expect(frontend.currentPhase).toBe('reading-story');
        expect(frontend.events[0].message).toBe('original');
    });
});

describe('SDLC Pipeline — edge cases', () => {
    it('changes-requested with no known owner returns unknown', () => {
        const result = applyReviewComplete(TMP, {
            prId: 99999,
            verdict: 'changes-requested',
        });
        expect(result.ok).toBe(true);
        expect(result.target).toBe('unknown');
    });

    it('build-complete with no known owner still updates DevOps status', () => {
        writeJson('.devops-status.json', {
            currentPhase: 'monitoring-build',
            events: [],
        });

        const result = applyBuildComplete(TMP, { prId: 99999, result: 'passed' });
        expect(result.ok).toBe(true);
        expect(result.storyOwner).toBe('unknown');

        const devops = readJson('.devops-status.json');
        expect(devops.currentPhase).toBe('build-passed');
    });

    it('findStoryOwnerByPrId finds PR across multiple agents', () => {
        writeJson('.frontend-status.json', { prs: [{ id: 100, status: 'active' }] });
        writeJson('.ux-status.json', { prs: [{ id: 200, status: 'active' }] });

        expect(findStoryOwnerByPrId(TMP, 100)!.agentId).toBe('frontend');
        expect(findStoryOwnerByPrId(TMP, 200)!.agentId).toBe('ux');
        expect(findStoryOwnerByPrId(TMP, 300)).toBeNull();
    });

    it('approved review reads PR title/url from reviewer file and clears reviewer', () => {
        writeJson('.reviewer-status.json', {
            currentPhase: 'approved',
            assignedPR: { id: 44444, title: 'Custom Title', url: 'https://custom.url/44444' },
            events: [],
        });

        applyReviewComplete(TMP, { prId: 44444, verdict: 'approved' });

        const devops = readJson('.devops-status.json');
        expect(devops.assignedPR.title).toBe('Custom Title');
        expect(devops.assignedPR.url).toBe('https://custom.url/44444');

        const reviewer = readJson('.reviewer-status.json');
        expect(reviewer.currentPhase).toBe('watching-build');
    });
});
