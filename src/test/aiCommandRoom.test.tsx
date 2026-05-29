import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AICommandRoom } from '../dashboard/components/AICommandRoom';
import * as aiHealthHooks from '../dashboard/hooks/useAIHealth';

// Mock the hooks
vi.mock('../dashboard/hooks/useAIHealth');
vi.mock('../dashboard/hooks/useFocusTrap', () => ({
    useFocusTrap: vi.fn()
}));

const mockUseMeshLLMHealth = vi.mocked(aiHealthHooks.useMeshLLMHealth);
const mockUseMeshLLMModels = vi.mocked(aiHealthHooks.useMeshLLMModels);
const mockUseOllamaHealth = vi.mocked(aiHealthHooks.useOllamaHealth);
const mockUseOllamaModels = vi.mocked(aiHealthHooks.useOllamaModels);
const mockUseMLXHealth = vi.mocked(aiHealthHooks.useMLXHealth);
const mockSelectMeshLLMNode = vi.mocked(aiHealthHooks.selectMeshLLMNode);

describe('AICommandRoom', () => {
    const defaultProps = {
        open: true,
        onClose: vi.fn(),
        cursorAiEnabled: true,
        toggleCursorAi: vi.fn(),
        claudeEnabled: true,
        toggleClaudeAi: vi.fn(),
        opencodeEnabled: true,
        toggleOpenCode: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', vi.fn(async () => ({
            json: async () => ({
                apiKey: 'sk-or-v1...test',
                model: 'deepseek/deepseek-v3.2',
                configured: true,
                provider: 'openrouter',
                source: 'env',
                baseUrl: 'https://openrouter.ai/api/v1',
                providerEnabled: { meshllm: true, ollama: true, openrouter: true },
            }),
        })));

        // Default mock implementations
        mockUseMeshLLMHealth.mockReturnValue({
            isHealthy: true,
            peers: 2,
            models: ['qwen3:8b', 'llama3:7b'],
            nodes: [
                { id: 'node1', name: 'Node 1', models: ['qwen3:8b'], latency: 50 },
                { id: 'node2', name: 'Node 2', models: ['llama3:7b'], latency: 120 }
            ],
            selectedNode: 'node1',
            launch: { canLaunch: false, source: null, reason: 'Set MESHLLM_START_COMMAND' },
            isLoading: false
        });

        mockUseMeshLLMModels.mockReturnValue({
            isLoading: false,
            available: true,
            models: [
                { id: 'unsloth/Qwen3-32B-GGUF:Q4_K_M', label: 'Qwen3 32B' },
                { id: 'unsloth/Qwen3-8B-GGUF@main:Q4_K_M', label: 'Qwen3 8B' },
            ],
            error: null,
            lastChecked: '09:41 AM',
        });

        mockUseOllamaHealth.mockReturnValue({
            isHealthy: true,
            activeModel: 'sdlc-tuned:latest',
            tunedModelReady: true,
            canLaunch: false,
            isLoading: false
        });
        mockUseOllamaModels.mockReturnValue([]);
        mockUseMLXHealth.mockReturnValue({
            isHealthy: true,
            models: ['mlx-community/Qwen2.5-Coder-14B-Instruct-4bit'],
            isLoading: false,
        });

        mockSelectMeshLLMNode.mockResolvedValue(true);
    });

    it('should not render when closed', () => {
        render(<AICommandRoom {...defaultProps} open={false} />);

        expect(screen.queryByText('AI Command Room')).not.toBeInTheDocument();
    });

    it('should render AI Command Room when open', () => {
        render(<AICommandRoom {...defaultProps} />);

        expect(screen.getByText('AI Command Room')).toBeInTheDocument();
        expect(screen.getByText('MeshLLM')).toBeInTheDocument();
        expect(screen.getByText('Ollama')).toBeInTheDocument();
        expect(screen.getByText('Cloud Providers')).toBeInTheDocument();
    });

    it('should show OpenRouter fallback provider status', async () => {
        render(<AICommandRoom {...defaultProps} />);

        expect(await screen.findByText('OpenRouter configured')).toBeInTheDocument();
        expect(screen.getByText('deepseek/deepseek-v3.2 via env')).toBeInTheDocument();
        expect(screen.getByText(/Status: configured \(openrouter\)/)).toBeInTheDocument();
    });

    it('should show MeshLLM status correctly', () => {
        render(<AICommandRoom {...defaultProps} />);

        expect(screen.getByText('Connected to mesh')).toBeInTheDocument();
        expect(screen.getByText('2 peers available')).toBeInTheDocument();
    });

    it('should show Ollama status correctly', () => {
        render(<AICommandRoom {...defaultProps} />);

        expect(screen.getByText('Ollama')).toBeInTheDocument();
        expect(screen.getByText('★ sdlc-tuned:latest')).toBeInTheDocument();
    });

    it('should show MeshLLM node selector when nodes are available', () => {
        render(<AICommandRoom {...defaultProps} />);

        expect(screen.getByText('Select Node:')).toBeInTheDocument();
        const nodeSelect = screen.getByLabelText('Select Node:');
        expect(nodeSelect).toHaveValue('node1');
    });

    it('should handle node selection', async () => {
        render(<AICommandRoom {...defaultProps} />);

        const nodeSelect = screen.getByLabelText('Select Node:');
        fireEvent.change(nodeSelect, { target: { value: 'node2' } });

        await waitFor(() => {
            expect(mockSelectMeshLLMNode).toHaveBeenCalledWith('node2');
        });
    });

    it('shows a polling MeshLLM model selector and saves the selected model id', async () => {
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            if (url === '/api/loop-provider' && init?.method === 'PUT') {
                return { ok: true, json: async () => ({ ok: true }) };
            }
            return {
                ok: true,
                json: async () => ({
                    apiKey: null,
                    model: 'unsloth/Qwen3-32B-GGUF:Q4_K_M',
                    configured: true,
                    provider: 'meshllm',
                    source: 'config',
                    baseUrl: 'http://localhost:9337/v1',
                    providerEnabled: { meshllm: true, ollama: true, openrouter: true },
                }),
            };
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<AICommandRoom {...defaultProps} />);

        expect(screen.getByText('2 online')).toBeInTheDocument();
        const modelSelect = screen.getByTestId('meshllm-model-select');
        fireEvent.change(modelSelect, { target: { value: 'unsloth/Qwen3-8B-GGUF@main:Q4_K_M' } });

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith('/api/loop-provider', expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({
                    baseUrl: 'http://localhost:9337/v1',
                    model: 'unsloth/Qwen3-8B-GGUF@main:Q4_K_M',
                    providerEnabled: { meshllm: true, ollama: true, openrouter: true, mlx: true },
                }),
            }));
        });
    });

    it('shows MeshLLM routing as an explicit agent switch', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({
                apiKey: null,
                model: 'unsloth/Qwen3-32B-GGUF:Q4_K_M',
                configured: true,
                provider: 'meshllm',
                source: 'config',
                baseUrl: 'http://localhost:9337/v1',
                providerEnabled: { meshllm: true, ollama: true, openrouter: true },
            }),
        })));

        render(<AICommandRoom {...defaultProps} />);

        const meshToggle = await screen.findByRole('button', { name: 'Use MeshLLM for agents' });
        expect(meshToggle).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText('MeshLLM selected')).toBeInTheDocument();
    });

    it('turns MeshLLM routing off without hiding other providers', async () => {
        let loopProvider = {
            apiKey: 'sk-or-v1...test',
            model: 'unsloth/Qwen3-32B-GGUF:Q4_K_M',
            configured: true,
            provider: 'meshllm',
            source: 'config',
            baseUrl: 'http://localhost:9337/v1',
            providerEnabled: { meshllm: true, ollama: true, openrouter: true },
        };
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            if (url === '/api/loop-provider' && init?.method === 'PUT') {
                const body = JSON.parse(String(init.body));
                loopProvider = {
                    ...loopProvider,
                    provider: 'openrouter',
                    baseUrl: 'https://openrouter.ai/api/v1',
                    model: 'deepseek/deepseek-v3.2',
                    providerEnabled: body.providerEnabled,
                };
                return { ok: true, json: async () => ({ ok: true }) };
            }
            return { ok: true, json: async () => loopProvider };
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<AICommandRoom {...defaultProps} />);

        const meshToggle = await screen.findByRole('button', { name: 'Use MeshLLM for agents' });
        fireEvent.click(meshToggle);

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith('/api/loop-provider', expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({
                    providerEnabled: { meshllm: false, ollama: true, openrouter: true, mlx: true },
                }),
            }));
        });
        await waitFor(() => {
            expect(screen.getByText('OpenRouter configured')).toBeInTheDocument();
        });
    });

    it('can turn Ollama and OpenRouter routing off explicitly', async () => {
        let loopProvider = {
            apiKey: 'sk-or-v1...test',
            model: 'deepseek/deepseek-v3.2',
            configured: true,
            provider: 'openrouter',
            source: 'env',
            baseUrl: 'https://openrouter.ai/api/v1',
            providerEnabled: { meshllm: true, ollama: true, openrouter: true },
        };
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            if (url === '/api/loop-provider' && init?.method === 'PUT') {
                const body = JSON.parse(String(init.body));
                loopProvider = { ...loopProvider, providerEnabled: body.providerEnabled };
                return { ok: true, json: async () => ({ ok: true }) };
            }
            return { ok: true, json: async () => loopProvider };
        });
        vi.stubGlobal('fetch', fetchMock);

        render(<AICommandRoom {...defaultProps} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Use Ollama for agents' }));
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith('/api/loop-provider', expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({
                    providerEnabled: { meshllm: true, ollama: false, openrouter: true, mlx: true },
                }),
            }));
        });

        fireEvent.click(screen.getByRole('button', { name: 'Use OpenRouter for agents' }));
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith('/api/loop-provider', expect.objectContaining({
                method: 'PUT',
                body: JSON.stringify({
                    providerEnabled: { meshllm: true, ollama: false, openrouter: false, mlx: true },
                }),
            }));
        });
    });

    it('should show loading state for MeshLLM', () => {
        mockUseMeshLLMHealth.mockReturnValue({
            isHealthy: false,
            peers: 0,
            models: [],
            nodes: [],
            launch: { canLaunch: false, source: null, reason: 'Set MESHLLM_START_COMMAND' },
            isLoading: true
        });

        render(<AICommandRoom {...defaultProps} />);

        expect(screen.getByText('Checking...')).toBeInTheDocument();
    });

    it('should show unhealthy state for MeshLLM', () => {
        mockUseMeshLLMHealth.mockReturnValue({
            isHealthy: false,
            peers: 0,
            models: [],
            nodes: [],
            launch: { canLaunch: false, source: null, reason: 'Set MESHLLM_START_COMMAND' },
            isLoading: false
        });

        render(<AICommandRoom {...defaultProps} />);

        expect(screen.getByText('Not available')).toBeInTheDocument();
    });

    it('shows a MeshLLM launch/configure control when MeshLLM is unavailable', () => {
        mockUseMeshLLMHealth.mockReturnValue({
            isHealthy: false,
            peers: 0,
            models: [],
            nodes: [],
            launch: { canLaunch: false, source: null, reason: 'Set MESHLLM_START_COMMAND' },
            isLoading: false
        });

        render(<AICommandRoom {...defaultProps} />);

        expect(screen.getByTestId('meshllm-launch-btn')).toHaveTextContent('Configure Launch');
        expect(screen.getByText('Set MESHLLM_START_COMMAND')).toBeInTheDocument();
    });

    it('should toggle Cursor AI when clicked', () => {
        render(<AICommandRoom {...defaultProps} />);

        const cursorToggle = screen.getByRole('button', { name: 'Use Cursor AI' });
        fireEvent.click(cursorToggle);

        expect(defaultProps.toggleCursorAi).toHaveBeenCalled();
    });

    it('should toggle Claude AI when clicked', () => {
        render(<AICommandRoom {...defaultProps} />);

        const claudeToggle = screen.getByRole('button', { name: 'Use Claude AI' });
        fireEvent.click(claudeToggle);

        expect(defaultProps.toggleClaudeAi).toHaveBeenCalled();
    });

    it('should close when close button is clicked', () => {
        render(<AICommandRoom {...defaultProps} />);

        const closeButton = screen.getByLabelText('Close AI Command Room');
        fireEvent.click(closeButton);

        expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it('should close when back button is clicked', () => {
        render(<AICommandRoom {...defaultProps} />);

        const backButton = screen.getByText('Back to Floor');
        fireEvent.click(backButton);

        expect(defaultProps.onClose).toHaveBeenCalled();
    });

    it('should handle disabled AI providers correctly', () => {
        render(<AICommandRoom {...defaultProps} cursorAiEnabled={false} claudeEnabled={false} />);

        const toggleButtons = screen.getAllByRole('button', { pressed: false });
        expect(toggleButtons.length).toBeGreaterThanOrEqual(2);
    });

    it('keeps provider toggles visually anchored inside the switch track', () => {
        render(<AICommandRoom {...defaultProps} />);

        const cursorToggle = screen.getByRole('button', { name: 'Use Cursor AI' });
        const thumb = cursorToggle.firstElementChild as HTMLElement;

        expect(cursorToggle).toHaveStyle({ padding: '0px', width: '44px', height: '24px' });
        expect(thumb).toHaveStyle({ left: '2px', width: '20px', height: '20px' });
    });
});
