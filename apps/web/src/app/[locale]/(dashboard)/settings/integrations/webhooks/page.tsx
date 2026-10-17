import { webhooksAPI, type WebhookSubscription } from '@/lib/api/webhooks';
import { teamsAPI, type TeamsOrganization } from '@/lib/api/teams';
import { WebhooksSettings } from '@/components/settings/WebhooksSettings';

/**
 * Settings → Webhooks (EW-P1-5): outbound webhook subscriptions — the legacy
 * work/deployment ones and v2 domain-event subscriptions — with their
 * deliveries and redelivery. The two reads are independent: a failed list
 * shows a load error (not "No webhooks yet"), and the organizations still
 * load so a webhook can be created.
 */
export default async function WebhooksSettingsPage() {
    const [subscriptions, organizations] = await Promise.allSettled([
        webhooksAPI.list(),
        teamsAPI.listOrganizations(),
    ]);
    const list: WebhookSubscription[] =
        subscriptions.status === 'fulfilled' ? subscriptions.value : [];
    const orgs: TeamsOrganization[] =
        organizations.status === 'fulfilled' ? organizations.value : [];
    return (
        <WebhooksSettings
            initialSubscriptions={list}
            organizations={orgs}
            loadFailed={subscriptions.status === 'rejected'}
        />
    );
}
