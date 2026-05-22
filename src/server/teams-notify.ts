import { existsSync } from 'fs';
import { resolve } from 'path';
import { isMockExternalMode } from './external-mode';
import { appendMockNotification } from './mock-external';
import { parseJsonUtf8File } from './json-file';

function getSchedulerConfig(rootDir: string) {
    const configFile = resolve(rootDir, '.sdlc-framework.config.json');
    if (existsSync(configFile)) {
        try { return parseJsonUtf8File(configFile); } catch { /* fall through */ }
    }
    return { scheduler: { mode: 'notify', agents: { frontend: { enabled: true, autoStart: false } } } };
}

export async function sendTeamsNotification(rootDir: string, title: string, message: string, color?: string) {
    const configFile = resolve(rootDir, '.sdlc-framework.config.json');
    if (isMockExternalMode(configFile)) {
        appendMockNotification(rootDir, title, message, color);
        return;
    }
    const config = getSchedulerConfig(rootDir);
    const webhookUrl = config.notifications?.teams?.webhookUrl;
    if (!webhookUrl) return;
    const card = {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        themeColor: color || "6366f1",
        summary: title,
        sections: [{ activityTitle: title, activitySubtitle: new Date().toLocaleString(), text: message, markdown: true }] };
    try {
        await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card) });
    } catch { /* silent */ }
}
