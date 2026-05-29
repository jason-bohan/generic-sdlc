import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AIHealth } from '../dashboard/AIHealth';
import * as aiHealthHooks from '../dashboard/hooks/useAIHealth';

vi.mock('../dashboard/hooks/useAIHealth');
vi.mock('../dashboard/hooks/useFocusTrap', () => ({
    useFocusTrap: vi.fn()
}));

const mockUseMeshLLMHealth = vi.mocked(aiHealthHooks.useMeshLLMHealth);
const mockUseOllamaHealth = vi.mocked(aiHealthHooks.useOllamaHealth);
const mockUseMLXHealth = vi.mocked(aiHealthHooks.useMLXHealth);
const mockSelectMeshLLMNode = vi.mocked(aiHealthHooks.selectMeshLLMNode);

describe('AI Health Hooks', () => {
    const mockMeshLLMHealth = {
        isHealthy: true,
        peers: 2,
        models: ['qwen3:8b', 'llama3:7b'],
        nodes: [
            { id: 'node1', name: 'Node 1', models: ['qwen3:8b'], latency: 50 },
            { id: 'node2', name: 'Node 2', models: ['llama3:7b'], latency: 120 }
        ],
        selectedNode: 'node1',
        isLoading: false
    };

    const mockMLXHealth = {
        isHealthy: false,
        models: [],
        isLoading: false
    };

    const mockOllamaHealth = {
        isHealthy: true,
        activeModel: 'sdlc-tuned:latest',
        tunedModelReady: true,
        canLaunch: false,
        isLoading: false
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockUseMeshLLMHealth.mockReturnValue(mockMeshLLMHealth);
        mockUseOllamaHealth.mockReturnValue(mockOllamaHealth);
        mockUseMLXHealth.mockReturnValue(mockMLXHealth);
        mockSelectMeshLLMNode.mockResolvedValue(true);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should display MeshLLM health status', () => {
        render(<AIHealth />);
        expect(screen.getByText('MeshLLM')).toBeInTheDocument();
        expect(screen.getByText('Connected to mesh')).toBeInTheDocument();
        expect(screen.getByText('2 peers available')).toBeInTheDocument();
    });

    it('should display MLX and Ollama as separate local rows', () => {
        mockUseMLXHealth.mockReturnValue({ isHealthy: true, models: ['Qwen2.5-Coder-14B'], isLoading: false });
        render(<AIHealth />);
        expect(screen.getByText('MLX')).toBeInTheDocument();
        expect(screen.getByText('Ollama')).toBeInTheDocument();
        expect(screen.getByText('Qwen2.5-Coder-14B')).toBeInTheDocument();
        expect(screen.getByText('sdlc-tuned:latest')).toBeInTheDocument();
        // Both locals up → two "Running locally" rows (no longer lumped into one).
        expect(screen.getAllByText('Running locally')).toHaveLength(2);
    });

    it('should display loading state for MeshLLM', () => {
        mockUseMeshLLMHealth.mockReturnValue({ ...mockMeshLLMHealth, isLoading: true });
        render(<AIHealth />);
        expect(screen.getByText('Checking...')).toBeInTheDocument();
    });

    it('should display unhealthy state for MeshLLM', () => {
        mockUseMeshLLMHealth.mockReturnValue({ ...mockMeshLLMHealth, isHealthy: false, isLoading: false });
        mockUseMLXHealth.mockReturnValue({ ...mockMLXHealth, isHealthy: true, models: ['qwen:7b'] });
        render(<AIHealth />);
        expect(screen.getByText('Not available')).toBeInTheDocument();
    });

    it('should display loading state for Ollama', () => {
        mockUseOllamaHealth.mockReturnValue({ ...mockOllamaHealth, isLoading: true });
        render(<AIHealth />);
        expect(screen.getByText('Checking...')).toBeInTheDocument();
    });

    it('should display unhealthy state for both MLX and Ollama when they are down', () => {
        mockUseMeshLLMHealth.mockReturnValue({ ...mockMeshLLMHealth, isHealthy: true, isLoading: false });
        mockUseOllamaHealth.mockReturnValue({ ...mockOllamaHealth, isHealthy: false, isLoading: false });
        mockUseMLXHealth.mockReturnValue({ ...mockMLXHealth, isHealthy: false, isLoading: false });
        render(<AIHealth />);
        // MLX row + Ollama row both report unavailable (mesh is healthy here).
        expect(screen.getAllByText('Not available')).toHaveLength(2);
    });

    // selectMeshLLMNode tests use the real implementation (not the mock) so
    // the fetch assertions are meaningful. importActual restores the real fn
    // while the rest of the module stays mocked.
    describe('selectMeshLLMNode', () => {
        const mockFetch = vi.fn();
        let realSelectMeshLLMNode: (nodeId: string) => Promise<boolean>;

        beforeAll(async () => {
            const actual = await vi.importActual<typeof aiHealthHooks>('../dashboard/hooks/useAIHealth');
            realSelectMeshLLMNode = actual.selectMeshLLMNode;
        });

        beforeEach(() => {
            vi.stubGlobal('fetch', mockFetch);
            mockSelectMeshLLMNode.mockImplementation(realSelectMeshLLMNode);
            mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
        });

        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('should successfully select a node', async () => {
            const result = await aiHealthHooks.selectMeshLLMNode('node1');
            expect(result).toBe(true);
            expect(mockFetch).toHaveBeenCalledWith(
                '/api/meshllm/nodes/select',
                expect.objectContaining({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nodeId: 'node1' }),
                })
            );
        });

        it('should handle selection failure', async () => {
            mockFetch.mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: 'Selection failed' }) });
            const result = await aiHealthHooks.selectMeshLLMNode('node1');
            expect(result).toBe(false);
        });

        it('should handle non-ok response', async () => {
            mockFetch.mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: 'Network error' }) });
            const result = await aiHealthHooks.selectMeshLLMNode('invalid-node');
            expect(result).toBe(false);
        });

        it('should handle fetch errors', async () => {
            mockFetch.mockRejectedValue(new Error('Network error'));
            const result = await aiHealthHooks.selectMeshLLMNode('node1');
            expect(result).toBe(false);
        });
    });
});
