import { describe, it, expect, beforeAll } from 'vitest';

/**
 * Validates that Floor3D scene has reliable click targets for all interactive elements.
 * This test guards against regressions where desks or objects lose their click handlers,
 * invisible hit boxes get removed, or desk positions lack matching roster entries.
 */
describe('Floor3D click targets', () => {
    let floor3d: string;
    let sceneContent: string;
    let agentDesk: string;
    let sceneRig: string;

    beforeAll(async () => {
        const fs = await import('fs');
        floor3d = fs.readFileSync('src/dashboard/floor3d/Floor3D.tsx', 'utf-8');
        sceneContent = fs.readFileSync('src/dashboard/floor3d/SceneContent.tsx', 'utf-8');
        agentDesk = fs.readFileSync('src/dashboard/floor3d/AgentDesk.tsx', 'utf-8');
        sceneRig = fs.readFileSync('src/dashboard/floor3d/SceneRig.tsx', 'utf-8');
    });

    it('AgentDesk group has onClick and onDoubleClick handlers', () => {
        const startIdx = agentDesk.indexOf('export function AgentDesk(');
        expect(startIdx, 'Could not find AgentDesk function').toBeGreaterThan(-1);
        const deskFn = agentDesk.slice(startIdx, startIdx + 3000);

        const hasGroupOnClick = /onClick=\{/.test(deskFn);
        expect(hasGroupOnClick, 'AgentDesk must have an onClick handler (on the group or a hit mesh)').toBe(true);

        const hasGroupOnDblClick = /onDoubleClick=\{/.test(deskFn);
        expect(hasGroupOnDblClick, 'AgentDesk must have an onDoubleClick handler').toBe(true);
    });

    it('AgentDesk has an invisible hit-detection mesh for reliable raycasting', () => {
        const startIdx = agentDesk.indexOf('export function AgentDesk(');
        expect(startIdx, 'Could not find AgentDesk function').toBeGreaterThan(-1);
        const deskFn = agentDesk.slice(startIdx, startIdx + 3000);

        const hasInvisibleMesh = /visible=\{false\}/.test(deskFn);
        expect(hasInvisibleMesh,
            'AgentDesk must have a visible={false} hit-detection mesh. ' +
            'Without this, desks far from camera center (e.g. reviewer, DevOps) have unreliable click detection.'
        ).toBe(true);
    });

    it('Mainframe click group has an invisible hit-detection mesh', () => {
        const mainframeClickSection = sceneContent.match(/onObjectClick\('mainframe'\)[\s\S]*?<\/group>/);
        expect(mainframeClickSection, 'Could not find mainframe click group').toBeTruthy();
        const section = mainframeClickSection![0];

        const hasInvisibleMesh = /visible=\{false\}/.test(section);
        expect(hasInvisibleMesh,
            'Mainframe click group must have a visible={false} hit-detection mesh for reliable clicking.'
        ).toBe(true);
    });

    it('DESK_POSITIONS length matches AGENT_ROSTER length', () => {
        const fs = require('fs');
        const source = fs.readFileSync('src/dashboard/floor3d/constants.ts', 'utf-8');
        const posMatch = source.match(/export const DESK_POSITIONS[\s\S]*?\];/);
        expect(posMatch, 'Could not find DESK_POSITIONS array').toBeTruthy();

        const posCount = (posMatch![0].match(/\[[\d\s.,\-]+\]/g) || []).length;

        const rosterImport = /import.*AGENT_ROSTER.*from/.test(floor3d);
        expect(rosterImport, 'Floor3D must import AGENT_ROSTER').toBe(true);

        const typesSource = fs.readFileSync('src/dashboard/types.ts', 'utf-8');
        const rosterMatch = typesSource.match(/export const AGENT_ROSTER[\s\S]*?\];/);
        expect(rosterMatch, 'Could not find AGENT_ROSTER in types.ts').toBeTruthy();

        const rosterCount = (rosterMatch![0].match(/\bid:\s*'/g) || []).length;

        expect(posCount,
            `DESK_POSITIONS has ${posCount} entries but AGENT_ROSTER has ${rosterCount}. ` +
            'Every agent needs a desk position or clicks will fail for agents past the array bounds.'
        ).toBe(rosterCount);
    });

    it('All active agents in AGENT_ROSTER have active: true checked in click handler', () => {
        const handlerMatch = floor3d.match(/handleDeskClick[\s\S]*?\}, \[/);
        expect(handlerMatch, 'Could not find handleDeskClick').toBeTruthy();
        const handler = handlerMatch![0];

        const checksActive = /agent\.active/.test(handler);
        expect(checksActive, 'handleDeskClick should check agent.active to gate inactive desks').toBe(true);
    });

    it('SceneContent passes onDeskClick to AgentDesk components', () => {
        const startIdx = sceneContent.indexOf('export function SceneContent(');
        expect(startIdx, 'Could not find SceneContent function').toBeGreaterThan(-1);
        const sc = sceneContent.slice(startIdx, startIdx + 6000);

        const passesOnClick = /onDeskClick/.test(sc);
        expect(passesOnClick, 'SceneContent must reference onDeskClick to pass to AgentDesk').toBe(true);
    });

    it('Camera zoom target changes when focusedAgent is set', () => {
        const zoomLine = sceneRig.match(/targetZoom\s*=.*focusedAgent/);
        expect(zoomLine,
            'targetZoom must depend on focusedAgent so camera zooms in when a desk is clicked'
        ).toBeTruthy();
    });

    it('targetLookAt uses DESK_POSITIONS indexed by AGENT_ROSTER', () => {
        const lookAtBlock = sceneRig.match(/targetLookAt[\s\S]*?useMemo\(\(\)[\s\S]*?\[focusedAgent/);
        expect(lookAtBlock, 'Could not find targetLookAt useMemo').toBeTruthy();
        const block = lookAtBlock![0];

        const usesDeskPositions = /DESK_POSITIONS\[/.test(block) || /deskPositions\[/.test(block);
        expect(usesDeskPositions,
            'targetLookAt must index into DESK_POSITIONS (or derived deskPositions) so camera pans to the correct desk'
        ).toBe(true);

        const usesRosterFindIndex = /AGENT_ROSTER\.findIndex/.test(block);
        expect(usesRosterFindIndex,
            'targetLookAt must use AGENT_ROSTER.findIndex to map focusedAgent to position index'
        ).toBe(true);
    });
});
