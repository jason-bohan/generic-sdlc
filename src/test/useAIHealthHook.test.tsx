import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { selectMeshLLMNode, useMeshLLMHealth } from '../dashboard/hooks/useAIHealth';

describe('useAIHealth hooks', () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('loads MeshLLM status through the SDLC Framework API proxy', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                available: true,
                peers: 2,
                models: ['qwen3:8b'],
                nodes: [{ id: 'node1', name: 'Node 1', models: ['qwen3:8b'], latency: 50 }],
                selectedNode: 'node1',
            }),
        });

        const { result } = renderHook(() => useMeshLLMHealth());

        await waitFor(() => expect(result.current.isLoading).toBe(false));

        expect(mockFetch).toHaveBeenCalledWith('/api/meshllm/health', expect.any(Object));
        expect(result.current).toMatchObject({
            isHealthy: true,
            peers: 2,
            models: ['qwen3:8b'],
            selectedNode: 'node1',
        });
    });

    it('selects MeshLLM nodes through the SDLC Framework API proxy', async () => {
        mockFetch.mockResolvedValue({ ok: true });

        await expect(selectMeshLLMNode('node1')).resolves.toBe(true);
        expect(mockFetch).toHaveBeenCalledWith('/api/meshllm/nodes/select', expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodeId: 'node1' }),
        }));
    });
});
