import { json } from '../router';
import { getMlxHealth, listMlxModels, isMlxAvailable } from '../mlxProvider';
import type { UseFn } from './types';

export function mount(use: UseFn, _rootDir: string, _configFile: string): void {
    use('/api/mlx/health', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        try {
            json(res, await getMlxHealth());
        } catch { json(res, { error: 'health check failed' }, 500); }
    });

    use('/api/mlx/models', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        try {
            const models = await listMlxModels();
            json(res, { models, available: isMlxAvailable() });
        } catch { json(res, { error: 'failed to list models' }, 500); }
    });
}
