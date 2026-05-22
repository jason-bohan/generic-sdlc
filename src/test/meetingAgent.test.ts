import { describe, expect, it, vi } from 'vitest';
import {
    buildAiderMeetingPrompt,
    parseMeetingExtraction,
    processMeetingText,
    rememberMeetingText,
} from '../server/meeting-agent';

describe('meeting-agent extraction', () => {
    it('parses bounded high-confidence coding tasks and decisions from model output', () => {
        const parsed = parseMeetingExtraction(JSON.stringify({
            tasks: [
                { title: 'Move AI controls into AICommandRoom', confidence: 0.91, agentId: 'frontend' },
                { title: 'Maybe rename a variable later', confidence: 0.45, agentId: 'backend' },
                { title: 'Add tests for command room routing', confidence: 0.82, agentId: 'qa' },
                { title: 'Refactor all architecture', confidence: 0.99, agentId: 'devops' },
            ],
            decisions: [
                { summary: 'AI controls belong in AICommandRoom', confidence: 0.88 },
            ],
        }), 0.7);

        expect(parsed.tasks.map((t) => t.title)).toEqual([
            'Move AI controls into AICommandRoom',
            'Add tests for command room routing',
            'Refactor all architecture',
        ]);
        expect(parsed.tasks.every((t) => t.confidence >= 0.7)).toBe(true);
        expect(parsed.decisions).toHaveLength(1);
    });

    it('falls back safely when the model says NONE or returns malformed JSON', () => {
        expect(parseMeetingExtraction('NONE')).toEqual({ tasks: [], decisions: [] });
        expect(parseMeetingExtraction('not json at all')).toEqual({ tasks: [], decisions: [] });
    });
});

describe('meeting-agent memory and dispatch', () => {
    it('keeps meeting memory bounded to recent context', () => {
        const memory: string[] = [];
        for (let i = 0; i < 14; i++) rememberMeetingText(memory, `message ${i}`);
        expect(memory).toHaveLength(10);
        expect(memory[0]).toBe('message 4');
        expect(memory[9]).toBe('message 13');
    });

    it('dispatches high-confidence tasks and returns a human-visible trace', async () => {
        const extract = vi.fn(async () => ({
            tasks: [{ title: 'Move AI controls into AICommandRoom', confidence: 0.91, agentId: 'frontend' }],
            decisions: [{ summary: 'AI controls belong in AICommandRoom', confidence: 0.88 }],
        }));
        const dispatchTask = vi.fn(async () => ({ spawned: true, reason: 'started' }));

        const result = await processMeetingText({
            text: 'We should move AI controls into AICommandRoom and add tests.',
            meetingId: 'meet-1',
            speaker: 'Pat',
            execute: true,
            memory: ['previous message'],
        }, { extract, dispatchTask });

        expect(extract).toHaveBeenCalledWith(expect.objectContaining({
            text: 'We should move AI controls into AICommandRoom and add tests.',
            recentContext: ['previous message'],
        }));
        expect(dispatchTask).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Move AI controls into AICommandRoom',
                agentId: 'frontend',
            }),
            expect.objectContaining({
                meetingId: 'meet-1',
                speaker: 'Pat',
                recentContext: ['previous message'],
            }),
        );
        expect(result.dispatched).toHaveLength(1);
        expect(result.trace[0]).toMatchObject({
            type: 'task',
            title: 'Move AI controls into AICommandRoom',
            confidence: 0.91,
            action: 'dispatched',
        });
        expect(result.reply).toContain('Task detected');
    });

    it('does not dispatch when execution is disabled', async () => {
        const dispatchTask = vi.fn();
        const result = await processMeetingText({
            text: 'Refactor SettingsPanel',
            meetingId: 'meet-2',
            execute: false,
        }, {
            extract: async () => ({
                tasks: [{ title: 'Refactor SettingsPanel', confidence: 0.9, agentId: 'frontend' }],
                decisions: [],
            }),
            dispatchTask,
        });

        expect(dispatchTask).not.toHaveBeenCalled();
        expect(result.trace[0]).toMatchObject({ action: 'held' });
        expect(result.reply).toContain('Task detected');
    });

    it('builds a constrained Aider prompt from meeting context', () => {
        const prompt = buildAiderMeetingPrompt({
            title: 'Move AI controls into AICommandRoom',
            confidence: 0.91,
            agentId: 'frontend',
        }, {
            meetingId: 'meet-1',
            speaker: 'Pat',
            recentContext: ['Earlier: AI controls are scattered.', 'Decision: consolidate controls.'],
        });

        expect(prompt).toContain('Meeting-derived coding task');
        expect(prompt).toContain('Move AI controls into AICommandRoom');
        expect(prompt).toContain('Do not push');
        expect(prompt).toContain('Add or update tests');
    });
});
