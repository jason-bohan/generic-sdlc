import type { NotificationPayload } from './types';

export interface INotifications {
    /** Send a notification to the configured channel */
    send(payload: NotificationPayload): Promise<boolean>;

    readonly providerName: string;
}
