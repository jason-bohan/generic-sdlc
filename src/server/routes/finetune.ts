import { json, cors, readBody } from '../router';
import { readFinetuneStatus, manualTriggerFinetune } from '../autoFinetune';
import type { UseFn } from './types';

export function mount(use: UseFn, rootDir: string): void {
    // GET /api/finetune/status
    use('/api/finetune/status', (req, res) => {
        cors(res, 'GET, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        json(res, readFinetuneStatus(rootDir));
    });

    // POST /api/finetune/trigger — manual kick
    use('/api/finetune/trigger', async (req, res) => {
        cors(res, 'POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        await readBody(req);
        const result = manualTriggerFinetune(rootDir);
        json(res, result, result.ok ? 200 : 409);
    });
}
