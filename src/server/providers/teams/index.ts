import type { INotifications } from '../INotifications';
import type { NotificationPayload } from '../types';

/**
 * Microsoft Teams adapter.
 * NOTIFY_PROVIDER=teams (default) | slack | none
 * For Slack: implement SlackNotifications with the same interface.
 */
export class TeamsNotifications implements INotifications {
    readonly providerName = 'teams';

    constructor(private rootDir: string) {}

    async send(payload: NotificationPayload): Promise<boolean> {
        const { sendTeamsNotification } = await import('../../teams-notify');
        await sendTeamsNotification(this.rootDir, payload.title, payload.body, payload.color);
        return true;
    }
}
