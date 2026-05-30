import { writeFileSync, existsSync } from 'fs';
import { parseJsonUtf8File } from '../json-file';
import { readBody, json, cors } from '../router';
import type { UseFn } from './types';
import type { DemoMode } from '../../shared/demoMode';
import { isValidDemoMode, DEFAULT_DEMO_MODE } from '../../shared/demoMode';

export function mount(use: UseFn, _rootDir: string, configFile: string): void {
    use('/api/demo-mode', async (req, res) => {
        cors(res, 'GET, PUT, OPTIONS');
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

        if (req.method === 'GET') {
            const mode = readDemoMode(configFile);
            json(res, { mode });
            return;
        }

        if (req.method === 'PUT') {
            const body = await readBody(req);
            try {
                const { mode } = JSON.parse(body.trim() || '{}');
                if (!isValidDemoMode(mode)) {
                    json(res, { error: 'mode must be "standard" or "financial"' }, 400);
                    return;
                }
                const cfg = existsSync(configFile) ? parseJsonUtf8File(configFile) : {};
                cfg.demoMode = mode;
                writeFileSync(configFile, JSON.stringify(cfg, null, 2));
                json(res, { mode });
            } catch (e: unknown) {
                json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
            }
            return;
        }

        res.statusCode = 405;
        res.end('Method not allowed');
    });
}

export function readDemoMode(configFile: string): DemoMode {
    if (!existsSync(configFile)) return DEFAULT_DEMO_MODE;
    try {
        const cfg = parseJsonUtf8File(configFile);
        const mode = cfg.demoMode;
        return isValidDemoMode(mode) ? mode : DEFAULT_DEMO_MODE;
    } catch {
        return DEFAULT_DEMO_MODE;
    }
}
