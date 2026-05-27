import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LocalBacklogView from '../dashboard/LocalBacklogView';

const board = {
    teams: [{ id: 'LocalTeam:1', name: 'SDLC Framework' }],
    members: [],
    classOfService: [{ id: 'LocalClassOfService:1', name: 'Standard' }],
    stories: [
        {
            id: 'LocalStory:LOCAL-B-0001',
            number: 'LOCAL-B-0001',
            name: 'Validate step-mode task pickup and batch execution flow',
            description: 'Check the step-mode task pickup contract.',
            status: 'Backlog',
            team: 'SDLC Framework',
            teamId: 'LocalTeam:1',
            estimate: 5,
            priority: 'High',
            scope: 'SDLC Framework',
            classOfService: 'Standard',
            acceptanceCriteria: '',
            frontend: '',
            backend: '',
            qa: '',
            tasks: [
                {
                    id: 'LocalTask:1',
                    number: 'LOCAL-T-0001',
                    name: 'Exercise selected-task pickup',
                    parent: 'LOCAL-B-0001',
                    status: 'Backlog',
                    owners: [],
                    estimate: 1,
                    todo: 1,
                    done: 0,
                    category: 'Frontend',
                },
            ],
        },
    ],
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe('LocalBacklogView', () => {
    it('renders local stories and switches tab views', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.includes('/api/planning/teams')) return { ok: true, json: async () => ({ teams: board.teams }) };
            if (url.includes('/api/planning/class-of-service')) return { ok: true, json: async () => ({ values: board.classOfService }) };
            if (url.includes('/api/planning/members')) return { ok: true, json: async () => ({ members: board.members }) };
            if (url.includes('/api/planning/story') && init?.method === 'PUT') return { ok: true, json: async () => ({ ok: true, story: board.stories[0], source: 'local' }) };
            if (url.includes('/api/planning/story?')) return { ok: true, json: async () => ({ ...board.stories[0], project: 'SDLC Framework', source: 'local' }) };
            if (url.includes('/api/planning/stories')) return { ok: true, json: async () => ({ stories: board.stories, total: board.stories.length, source: 'local' }) };
            if (url.includes('/api/planning/tasks')) return { ok: true, json: async () => ({ tasks: board.stories[0].tasks, source: 'local' }) };
            return { ok: true, json: async () => ({ error: `Unhandled test URL ${url}` }) };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        render(<LocalBacklogView onBack={() => {}} />);

        expect(await screen.findByText('Validate step-mode task pickup and batch execution flow')).toBeInTheDocument();
        expect(screen.getByText('Exercise selected-task pickup')).toBeInTheDocument();

        fireEvent.click(screen.getAllByText('Validate step-mode task pickup and batch execution flow')[0]);
        expect(await screen.findByText('LOCAL-B-0001 Story Details')).toBeInTheDocument();
        expect(screen.getAllByRole('option', { name: 'Closed' })).toHaveLength(1);
        expect(screen.getByPlaceholderText('Description')).toHaveValue('Check the step-mode task pickup contract.');
        fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'Updated editable description.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/planning/story', expect.objectContaining({ method: 'PUT' })));
        expect(await screen.findByText('Updated LOCAL-B-0001')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'List View' }));
        expect(screen.getByRole('heading', { name: 'List View' })).toBeInTheDocument();
        expect(screen.getByText('LOCAL-B-0001')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Closed' }));
        await waitFor(() => expect(screen.getByText('No closed local stories yet.')).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: 'Taskboard' }));
        const taskboard = screen.getByRole('region', { name: 'Local taskboard' });
        expect(within(taskboard).getByText('Exercise selected-task pickup')).toBeInTheDocument();
    });
});
