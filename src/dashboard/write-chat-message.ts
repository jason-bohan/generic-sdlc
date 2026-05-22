import type { ChatMessage } from './types';

const IS_TAURI = !!(typeof window !== 'undefined' && (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);

export async function writeChatMessage(agentId: string, msg: ChatMessage): Promise<void> {
    if (IS_TAURI) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('send_chat', { agentId, message: JSON.stringify(msg) });
            return;
        } catch (e) {
            console.warn('Tauri send_chat failed, falling back to fetch:', e);
        }
    }

    try {
        await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, message: msg }),
        });
    } catch (e) {
        console.warn('Chat POST failed:', e);
    }
}
