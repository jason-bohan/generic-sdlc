import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

describe('MeshLLM Docker Compose service', () => {
    it('does not include a meshllm service in the default compose stack', () => {
        const compose = YAML.parse(readFileSync(resolve(process.cwd(), 'docker-compose.yml'), 'utf8')) as any;
        expect(compose.services.meshllm).toBeUndefined();
    });

    it('can override MeshLLM into local model serving mode', () => {
        const compose = YAML.parse(readFileSync(resolve(process.cwd(), 'docker-compose.meshllm-local.yml'), 'utf8')) as any;
        const service = compose.services.meshllm;

        expect(service.image).toBe('${MESHLLM_IMAGE:-sdlc-framework-mesh-llm:cuda}');
        expect(service.environment.APP_MODE).toBe('model');
        expect(service.command).toContain('--auto');
        expect(service.command).toContain('${MESHLLM_MODEL_ARG:---model}');
        expect(service.command).toContain('${MESHLLM_MODEL:?Set MESHLLM_MODEL or pass -MeshLLMModel to bin/docker-up.ps1}');
        expect(service.volumes).toContain('${MESHLLM_MODEL_DIR:-.}:/models:ro');
    });

    it('passes NVIDIA GPUs through to MeshLLM when the GPU override is enabled', () => {
        const compose = YAML.parse(readFileSync(resolve(process.cwd(), 'docker-compose.gpu.yml'), 'utf8')) as any;
        const devices = compose.services.meshllm.deploy.resources.reservations.devices;

        expect(devices[0].driver).toBe('nvidia');
        expect(devices[0].capabilities).toContain('gpu');
    });

    it('does not wire MESHLLM_HOST into the server environment', () => {
        const compose = YAML.parse(readFileSync(resolve(process.cwd(), 'docker-compose.yml'), 'utf8')) as any;
        expect(compose.services.server.environment.MESHLLM_HOST).toBeUndefined();
    });
});
