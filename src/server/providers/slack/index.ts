import type { INotifications } from '../INotifications';
import type { NotificationPayload } from '../types';

const LEVEL_EMOJI: Record<string, string> = {
    success: ':white_check_mark:',
    error:   ':x:',
    warning: ':warning:',
    info:    ':information_source:',
};

export class SlackNotifications implements INotifications {
    readonly providerName = 'slack';

    private readonly webhookUrl: string;

    constructor(webhookUrl = process.env.SLACK_WEBHOOK_URL ?? '') {
        this.webhookUrl = webhookUrl;
    }

    async send(payload: NotificationPayload): Promise<boolean> {
        if (!this.webhookUrl) {
            console.warn('[slack] SLACK_WEBHOOK_URL not set — notification dropped');
            return false;
        }

        const emoji = LEVEL_EMOJI[payload.level ?? 'info'] ?? LEVEL_EMOJI.info;
        const titleLine = `${emoji} *${payload.title}*`;
        const blocks: unknown[] = [
            {
                type: 'section',
                text: { type: 'mrkdwn', text: titleLine },
            },
        ];

        if (payload.body) {
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: payload.body },
            });
        }

        if (payload.url) {
            blocks.push({
                type: 'actions',
                elements: [
                    {
                        type: 'button',
                        text: { type: 'plain_text', text: 'View' },
                        url: payload.url,
                    },
                ],
            });
        }

        try {
            const res = await fetch(this.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ blocks }),
            });
            if (!res.ok) {
                console.error(`[slack] webhook returned ${res.status}: ${await res.text()}`);
                return false;
            }
            return true;
        } catch (err) {
            console.error('[slack] failed to send notification:', err);
            return false;
        }
    }
}
