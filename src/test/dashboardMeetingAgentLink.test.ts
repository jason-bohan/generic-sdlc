import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('dashboard meeting agent entry point', () => {
    it('keeps a dashboard link to the meeting agent demo', () => {
        const routerSource = readFileSync(resolve(process.cwd(), 'src/dashboard/router.tsx'), 'utf8');
        const floorHeaderSource = readFileSync(resolve(process.cwd(), 'src/dashboard/components/FloorHeader.tsx'), 'utf8');

        expect(routerSource).toContain('data-testid="app-meeting-agent-btn"');
        expect(routerSource).toContain('href="/api/meeting-agent/messages"');
        expect(routerSource).toContain('Meeting Agent Demo');
        expect(floorHeaderSource).toContain('data-testid="simple-meeting-agent-btn"');
        expect(floorHeaderSource).toContain('href="/api/meeting-agent/messages"');
        expect(floorHeaderSource).toContain('Meeting Agent');
    });
});
