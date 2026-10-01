import 'server-only';
import type { ConnectedIdentitiesCardProps } from '@/components/settings/ConnectedIdentitiesCard';
import { everIdAPI, type EverIdIdentityList } from '@/lib/api/ever-id';
import { isEverIdOffered } from '@/lib/feature-flags/ever-id';
import { EVER_ID_RATE_LIMITED, toEverIdSecurityNotice, toRetryAfterSeconds } from './ever-id';
import { getEverIdAvailability } from './providers';

/**
 * APW-12 (Ever ID) — what Settings → Security needs for the Connected identities
 * card (spec §6.3, T26), resolved on the server.
 *
 * - The identities are read even while Ever ID is turned off: a person can always
 *   see and disconnect what is connected (FR-5, S18).
 * - "Connect Ever ID" is offered only when an administrator enabled Ever ID AND
 *   the `ever-id` flag is on for this person; the flag is not evaluated at all
 *   while Ever ID is off (`isEverIdOffered`).
 * - The `?everId=` notice is reduced to the closed set of codes the page may
 *   announce; anything else is ignored.
 */
export async function getEverIdSecuritySettings(
    userId: string,
    search: { everId?: unknown; retryAfter?: unknown } = {},
): Promise<ConnectedIdentitiesCardProps> {
    const [availability, identities] = await Promise.all([
        getEverIdAvailability(),
        everIdAPI.listIdentities().then(toIdentityList, () => null),
    ]);

    const canConnect = await isEverIdOffered(availability, userId);
    const notice = toEverIdSecurityNotice(firstValue(search.everId));

    return {
        identities,
        canConnect,
        turnedOff: !availability.enabled,
        notice,
        noticeRetryAfter:
            notice === EVER_ID_RATE_LIMITED
                ? toRetryAfterSeconds(firstValue(search.retryAfter) as string | undefined)
                : undefined,
    };
}

function firstValue(value: unknown): unknown {
    return Array.isArray(value) ? value[0] : value;
}

/** Keep the list only when it has the shape the card renders. */
function toIdentityList(value: EverIdIdentityList | undefined): EverIdIdentityList | null {
    if (!value || !Array.isArray(value.items)) return null;
    return {
        ...value,
        items: value.items.map((item) => ({
            ...item,
            delegatedClients: Array.isArray(item.delegatedClients) ? item.delegatedClients : [],
        })),
    };
}
