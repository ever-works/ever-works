import type { TenantEmailAddress } from '@ever-works/agent';

/**
 * The shape of a tenant email address as it may leave the server.
 *
 * `verificationToken` is deliberately absent, and so is
 * `verificationTokenExpiresAt` — the expiry is only meaningful alongside the
 * token, and publishing it tells an attacker how long a guess stays useful.
 */
export type PublicTenantEmailAddress = Omit<
    TenantEmailAddress,
    'verificationToken' | 'verificationTokenExpiresAt'
>;

/**
 * Strip the verification secret before an address crosses the API boundary.
 *
 * `POST /api/email/addresses` used to return the freshly-minted
 * `verificationToken` in its own response body, and `GET /api/email/addresses`
 * listed it for every stored address. Ownership of an address is proven by
 * receiving the emailed link, so handing the token straight back to the caller
 * removed the only proof the flow has. Reproduced end to end:
 *
 *   1. POST an address the caller does NOT control  -> 201, token in the JSON
 *   2. GET /api/email/verify/<token>  (unauthenticated)  -> 200 {"verified":true}
 *   3. read back  ->  that address is now `verified`
 *
 * No mail was ever sent. A verified address can then be used as an outbound
 * sender / `defaultForReplies`, i.e. to send mail that appears to originate
 * from someone else's address.
 *
 * The rest of the codebase already gets this right — signup verification
 * tokens are stored SHA-256 hashed (`hashToken`, `auth.service.ts`) so the
 * stored value is useless even to someone reading the database. This module is
 * the narrower fix for the email-address subsystem: the token still needs to
 * live in the row so the emailed link can be matched, so the boundary is where
 * it must be withheld.
 *
 * Applied at the CONTROLLER, not in the service: the service's callers include
 * the verification path itself, which legitimately needs the token. One
 * projection at the edge means a future endpoint that returns an address
 * cannot forget to strip it — provided it goes through here, which the test
 * enforces by asserting on the controller's actual responses.
 */
export function toPublicEmailAddress(address: TenantEmailAddress): PublicTenantEmailAddress {
    const {
        verificationToken: _verificationToken,
        verificationTokenExpiresAt: _verificationTokenExpiresAt,
        ...rest
    } = address as TenantEmailAddress & {
        verificationToken?: string | null;
        verificationTokenExpiresAt?: Date | null;
    };

    return rest as PublicTenantEmailAddress;
}

export function toPublicEmailAddresses(
    addresses: TenantEmailAddress[],
): PublicTenantEmailAddress[] {
    return addresses.map(toPublicEmailAddress);
}
