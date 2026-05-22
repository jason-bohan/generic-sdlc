import type { INotifications } from '../INotifications';
import type { NotificationPayload } from '../types';

/**
 * Microsoft Teams adapter.
 * NOTIFY_PROVIDER=teams (default) | slack | none
 * For Slack: implement SlackNotifications with the same interface.
 */
export class TeamsNotifications implements INotifications {
    readonly providerName = 'teams';

    async send(payload: NotificationPayload): Promise<boolean> {
        const { sendTeamsNotification } = await import('../../teams-notify');
        return sendTeamsNotification({
            title: payload.title,
            body: payload.body,
            url: payload.url,
            agentId: payload.agentId,
            level: payload.level,
        });
    }
}
