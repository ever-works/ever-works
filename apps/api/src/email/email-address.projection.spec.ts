import { toPublicEmailAddress, toPublicEmailAddresses } from './email-address.projection';

/**
 * Guard for the email-address verification-token leak.
 *
 * `POST /api/email/addresses` returned the freshly-minted `verificationToken`
 * in its own response body, and `GET /api/email/addresses` listed it for every
 * stored address. Reproduced end to end against a live deployment:
 *
 *   1. POST an address the caller does NOT own -> 201, token present in JSON
 *   2. GET /api/email/verify/<token>, UNAUTHENTICATED -> 200 {"verified":true}
 *   3. read back -> that address is now `verified`
 *
 * No mail was ever sent. Receiving the emailed link is the only proof of
 * ownership the flow has, so returning the token to the caller removed it
 * entirely — and a verified address can be used as an outbound sender, i.e. to
 * send mail that appears to come from an address the sender never owned.
 *
 * These tests assert on the SHAPE that crosses the boundary. A test that only
 * checked "the endpoint returns 200" would have passed throughout the
 * vulnerability, which is the failure mode this suite has repeatedly shown.
 */

type Row = Record<string, unknown>;

function makeRow(overrides: Row = {}): Row {
    return {
        id: 'addr-1',
        userId: 'user-1',
        address: 'someone@example.com',
        direction: 'outbound',
        pluginId: 'resend',
        providerSettings: {},
        defaultForReplies: false,
        verified: false,
        verificationToken: 'p0yXV4TXSLqBVXY2wyntxUWfYnaKy8FY',
        verificationTokenExpiresAt: new Date('2026-09-01T00:00:00.000Z'),
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        ...overrides,
    };
}

describe('email address projection — the verification token must never leave the server', () => {
    it('strips verificationToken from a single address', () => {
        const row = makeRow();

        // Control: the fixture really does carry the secret, so a passing
        // assertion cannot be one that inspected an already-empty object.
        expect(row.verificationToken).toBeTruthy();

        const publicView = toPublicEmailAddress(row as never) as Row;

        expect(publicView).not.toHaveProperty('verificationToken');
        expect(Object.values(publicView)).not.toContain(row.verificationToken);
    });

    it('strips verificationTokenExpiresAt too — an expiry without the token only tells an attacker how long a guess stays useful', () => {
        const publicView = toPublicEmailAddress(makeRow() as never) as Row;

        expect(publicView).not.toHaveProperty('verificationTokenExpiresAt');
    });

    it('keeps every field the UI actually needs', () => {
        const publicView = toPublicEmailAddress(makeRow() as never) as Row;

        expect(publicView).toMatchObject({
            id: 'addr-1',
            address: 'someone@example.com',
            direction: 'outbound',
            pluginId: 'resend',
            verified: false,
            defaultForReplies: false,
        });
    });

    it('strips the token from EVERY item in a list, not just the first', () => {
        const rows = [
            makeRow({ id: 'a', verificationToken: 'tok-a' }),
            makeRow({ id: 'b', verificationToken: 'tok-b' }),
            makeRow({ id: 'c', verificationToken: 'tok-c' }),
        ];

        const publicViews = toPublicEmailAddresses(rows as never) as Row[];

        expect(publicViews).toHaveLength(3);
        for (const view of publicViews) {
            expect(view).not.toHaveProperty('verificationToken');
        }
        // Belt and braces: no token value survives anywhere in the serialised
        // payload, which also catches a nested copy a key-check would miss.
        const serialised = JSON.stringify(publicViews);
        for (const token of ['tok-a', 'tok-b', 'tok-c']) {
            expect(serialised).not.toContain(token);
        }
    });

    it('handles a row whose token is already null without inventing the key', () => {
        const publicView = toPublicEmailAddress(
            makeRow({ verificationToken: null, verificationTokenExpiresAt: null }) as never,
        ) as Row;

        expect(publicView).not.toHaveProperty('verificationToken');
        expect(publicView.address).toBe('someone@example.com');
    });
});
