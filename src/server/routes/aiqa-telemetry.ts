import { cors, json } from '../router';
import { readTelemetry } from '../telemetry-reader';
import type { UseFn } from './types';

export function mount(use: UseFn, _rootDir: string, configFile: string): void {
    use('/api/aiqa/telemetry', async (req, res) => {
        cors(res, 'GET, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method not allowed'); return; }

        const result = await readTelemetry(configFile);
        json(res, result);
    });
}
