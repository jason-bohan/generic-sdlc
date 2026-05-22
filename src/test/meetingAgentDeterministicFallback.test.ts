import { describe, expect, it, vi } from 'vitest';
import { meshllmGenerate } from '../server/meshllmProvider';

vi.mock('../server/meshllmProvider', () => ({
    meshllmGenerate: vi.fn(async () => ({ response: '{"tasks":[],"decisions":[]}' })),
}));

describe('meeting-agent deterministic fallback extraction', () => {
    it('extracts explicit action-item coding tasks when the model returns no tasks', async () => {
        const { extractMeetingActions } = await import('../server/meeting-agent');

        const result = await extractMeetingActions({
            text: 'Action item for frontend: implement moving the AI controls into AICommandRoom and add tests for routing.',
            meetingId: 'demo-meeting-1',
            speaker: 'Demo User',
            recentContext: [],
        });

        expect(result.tasks[0]).toMatchObject({
            title: 'Implement moving the AI controls into AICommandRoom and add tests for routing.',
            agentId: 'frontend',
        });
        expect(result.tasks[0].confidence).toBeGreaterThanOrEqual(0.7);
        expect(result.decisions).toEqual([]);
        expect(meshllmGenerate).not.toHaveBeenCalled();
    });
});
