import { randomUUID } from 'crypto';
import type { AccountDeletionRequest } from '@ever-works/agent/entities';
import {
    AccountDeletionRequestPatch,
    AccountDeletionRequestStore,
    NewAccountDeletionRequest,
} from './account-deletion-request.store';
import {
    AccountDeletionTokenService,
    DeletionLinkRecipient,
    DeletionLinkSender,
    DeletionRecipientLookup,
    InvalidDeletionLinkError,
} from './account-deletion-token.service';
import {
    ACCOUNT_DELETION_MAX_REQUESTS_PER_EMAIL_PER_HOUR,
    buildDeletionLink,
    generateDeletionToken,
    hashDeletionEmail,
    hashDeletionToken,
    isWellFormedDeletionToken,
    maskEmail,
    resolveDeletionTokenTtlMinutes,
} from './account-deletion.tokens';

/** In-memory twin of the TypeORM store, with the same single-winner claim. */
class MemoryStore extends AccountDeletionRequestStore {
    rows: AccountDeletionRequest[] = [];

    constructor(private readonly clock: () => Date) {
        super();
    }

    async countIssuedSince(emailHash: string, since: Date): Promise<number> {
        return this.rows.filter(
            (r) =>
                r.emailHash === emailHash &&
                r.source === 'email_link' &&
                r.createdAt.getTime() >= since.getTime(),
        ).length;
    }

    async revokePending(emailHash: string): Promise<number> {
        let n = 0;
        for (const r of this.rows) {
            if (r.emailHash === emailHash && r.status === 'pending') {
                r.status = 'revoked';
                n += 1;
            }
        }
        return n;
    }

    async insert(row: NewAccountDeletionRequest): Promise<AccountDeletionRequest> {
        const entity = {
            id: randomUUID(),
            consumedAt: null,
            completedAt: null,
            summary: null,
            failureCode: null,
            createdAt: this.clock(),
            ...row,
        } as AccountDeletionRequest;
        this.rows.push(entity);
        return entity;
    }

    async findByTokenHash(tokenHash: string): Promise<AccountDeletionRequest | null> {
        return this.rows.find((r) => r.tokenHash === tokenHash) ?? null;
    }

    async claim(tokenHash: string, now: Date): Promise<boolean> {
        const row = this.rows.find(
            (r) =>
                r.tokenHash === tokenHash &&
                r.status === 'pending' &&
                !!r.expiresAt &&
                r.expiresAt.getTime() > now.getTime(),
        );
        if (!row) return false;
        row.status = 'consumed';
        row.consumedAt = now;
        return true;
    }

    async update(id: string, patch: AccountDeletionRequestPatch): Promise<void> {
        const row = this.rows.find((r) => r.id === id);
        if (row) Object.assign(row, patch);
    }

    async clearUser(userId: string): Promise<void> {
        for (const row of this.rows) if (row.userId === userId) row.userId = null;
    }
}

const JANE: DeletionLinkRecipient = { id: 'user-jane', email: 'jane@example.com', username: 'jane' };

function setup(options: { users?: DeletionLinkRecipient[]; sendFails?: boolean } = {}) {
    let now = new Date('2026-10-27T20:00:00.000Z');
    const clock = () => new Date(now.getTime());
    const store = new MemoryStore(clock);
    const users = options.users ?? [JANE];
    const lookup: DeletionRecipientLookup = {
        findByEmail: jest.fn(async (email: string) => users.find((u) => u.email === email) ?? null),
    };
    const sent: Array<{ to: string; deleteUrl: string; expiresInMinutes: number }> = [];
    const sender: DeletionLinkSender = {
        send: jest.fn(async (input) => {
            if (options.sendFails) throw new Error('smtp down');
            sent.push(input);
        }),
    };
    const scheduled: Array<() => Promise<void>> = [];
    const service = new AccountDeletionTokenService(
        store,
        lookup,
        sender,
        {
            defaultConfirmUrl: 'https://app.ever.works/delete-account/confirm',
            keepAccountUrl: 'https://app.ever.works/login',
            allowedCallbackHosts: new Set(['app.ever.works', 'ever.co']),
        },
        (task) => scheduled.push(task),
        clock,
    );
    const tokenFromLink = (link: string) => decodeURIComponent(link.split('token=')[1]);
    return {
        service,
        store,
        lookup,
        sender,
        sent,
        scheduled,
        tokenFromLink,
        advance: (ms: number) => {
            now = new Date(now.getTime() + ms);
        },
    };
}

describe('account-deletion token helpers', () => {
    it('generates 32 random bytes as 43 base64url characters, unique each time', () => {
        const a = generateDeletionToken();
        const b = generateDeletionToken();
        expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Buffer.from(a, 'base64url')).toHaveLength(32);
        expect(a).not.toEqual(b);
        expect(isWellFormedDeletionToken(a)).toBe(true);
    });

    it('refuses malformed tokens before any lookup', () => {
        for (const bad of [undefined, null, 42, '', 'short', 'x'.repeat(44), 'a+b/'.repeat(11)]) {
            expect(isWellFormedDeletionToken(bad)).toBe(false);
        }
    });

    it('hashes the token with sha256 (hex) and the email after trim + lower-case', () => {
        const token = generateDeletionToken();
        expect(hashDeletionToken(token)).toMatch(/^[0-9a-f]{64}$/);
        expect(hashDeletionToken(token)).not.toContain(token);
        expect(hashDeletionEmail('  Jane@Example.COM ')).toEqual(hashDeletionEmail('jane@example.com'));
    });

    it('puts the token in the URL fragment, or inside an existing hash route', () => {
        expect(buildDeletionLink('https://app.ever.works/delete-account/confirm', 'T')).toBe(
            'https://app.ever.works/delete-account/confirm#token=T',
        );
        expect(buildDeletionLink('https://app.gauzy.co/#/auth/delete-account/confirm', 'T')).toBe(
            'https://app.gauzy.co/#/auth/delete-account/confirm?token=T',
        );
    });

    it('clamps the TTL to 5..60 minutes with a 30-minute default', () => {
        expect(resolveDeletionTokenTtlMinutes(undefined)).toBe(30);
        expect(resolveDeletionTokenTtlMinutes('abc')).toBe(30);
        expect(resolveDeletionTokenTtlMinutes('1')).toBe(5);
        expect(resolveDeletionTokenTtlMinutes('600')).toBe(60);
        expect(resolveDeletionTokenTtlMinutes('15')).toBe(15);
    });

    it('masks the address it shows on the confirm page', () => {
        expect(maskEmail('jane@example.com')).toBe('j***@example.com');
    });
});

describe('AccountDeletionTokenService', () => {
    describe('enumeration-safe request', () => {
        it('answers the same thing for a known and an unknown address, before any lookup', () => {
            const { service, lookup, sender, scheduled } = setup();
            expect(service.acceptRequest({ email: 'jane@example.com' })).toEqual({ status: 'accepted' });
            expect(service.acceptRequest({ email: 'nobody@example.com' })).toEqual({ status: 'accepted' });
            expect(service.acceptRequest({ email: 'not an email' })).toEqual({ status: 'accepted' });
            // Nothing ran yet: the lookup and the send happen after the response.
            expect(lookup.findByEmail).not.toHaveBeenCalled();
            expect(sender.send).not.toHaveBeenCalled();
            expect(scheduled).toHaveLength(3);
        });

        it('sends only to an existing account and stores no row for an unknown one', async () => {
            const { service, store, sent, scheduled } = setup();
            service.acceptRequest({ email: 'Jane@Example.com' });
            service.acceptRequest({ email: 'nobody@example.com' });
            for (const task of scheduled) await task();
            expect(sent).toHaveLength(1);
            expect(sent[0].to).toBe('jane@example.com');
            expect(store.rows).toHaveLength(1);
        });

        it('stores only sha256(token), never the token or the address', async () => {
            const { service, store, sent, tokenFromLink } = setup();
            await service.issue({ email: 'jane@example.com' });
            const token = tokenFromLink(sent[0].deleteUrl);
            const row = store.rows[0];
            expect(row.tokenHash).toBe(hashDeletionToken(token));
            expect(row.emailHash).toBe(hashDeletionEmail('jane@example.com'));
            expect(JSON.stringify(row)).not.toContain(token);
            expect(JSON.stringify(row)).not.toContain('jane@example.com');
            expect(sent[0].deleteUrl).toMatch(/^https:\/\/app\.ever\.works\/delete-account\/confirm#token=/);
        });

        it('drops the 4th request for one address within an hour, silently', async () => {
            const { service, sent } = setup();
            for (let i = 0; i < ACCOUNT_DELETION_MAX_REQUESTS_PER_EMAIL_PER_HOUR; i += 1) {
                expect(await service.issue({ email: 'jane@example.com' })).toBe('sent');
            }
            expect(await service.issue({ email: 'jane@example.com' })).toBe('rate-limited');
            expect(sent).toHaveLength(ACCOUNT_DELETION_MAX_REQUESTS_PER_EMAIL_PER_HOUR);
        });

        it('retires the token when the email could not be sent', async () => {
            const { service, store } = setup({ sendFails: true });
            expect(await service.issue({ email: 'jane@example.com' })).toBe('send-failed');
            expect(store.rows[0].status).toBe('failed');
        });

        it('uses a caller callbackUrl only on an allowed host', () => {
            const { service } = setup();
            expect(service.resolveConfirmUrl('https://ever.co/delete/confirm')).toBe('https://ever.co/delete/confirm');
            expect(service.resolveConfirmUrl('https://evil.example/steal')).toBe(
                'https://app.ever.works/delete-account/confirm',
            );
            expect(service.resolveConfirmUrl('javascript:alert(1)')).toBe('https://app.ever.works/delete-account/confirm');
        });
    });

    describe('verify / confirm', () => {
        it('verify does not consume; confirm does, exactly once', async () => {
            const { service, sent, tokenFromLink } = setup();
            await service.issue({ email: 'jane@example.com' });
            const token = tokenFromLink(sent[0].deleteUrl);

            await expect(service.inspect(token)).resolves.toMatchObject({ userId: 'user-jane' });
            await expect(service.inspect(token)).resolves.toMatchObject({ status: 'pending' });

            await expect(service.claim(token)).resolves.toMatchObject({ status: 'consumed' });
            await expect(service.claim(token)).rejects.toBeInstanceOf(InvalidDeletionLinkError);
            await expect(service.inspect(token)).rejects.toBeInstanceOf(InvalidDeletionLinkError);
        });

        it('lets only one of two concurrent confirms win', async () => {
            const { service, sent, tokenFromLink } = setup();
            await service.issue({ email: 'jane@example.com' });
            const token = tokenFromLink(sent[0].deleteUrl);
            const results = await Promise.allSettled([service.claim(token), service.claim(token)]);
            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
            expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
        });

        it('refuses an expired link with the same error', async () => {
            const { service, sent, tokenFromLink, advance } = setup();
            await service.issue({ email: 'jane@example.com' });
            const token = tokenFromLink(sent[0].deleteUrl);
            advance(30 * 60 * 1000 + 1);
            await expect(service.inspect(token)).rejects.toBeInstanceOf(InvalidDeletionLinkError);
            await expect(service.claim(token)).rejects.toBeInstanceOf(InvalidDeletionLinkError);
        });

        it('a new request revokes the older unused link', async () => {
            const { service, sent, tokenFromLink } = setup();
            await service.issue({ email: 'jane@example.com' });
            await service.issue({ email: 'jane@example.com' });
            const first = tokenFromLink(sent[0].deleteUrl);
            const second = tokenFromLink(sent[1].deleteUrl);
            await expect(service.claim(first)).rejects.toBeInstanceOf(InvalidDeletionLinkError);
            await expect(service.claim(second)).resolves.toMatchObject({ status: 'consumed' });
        });

        it('refuses unknown and malformed tokens identically', async () => {
            const { service } = setup();
            await expect(service.inspect(generateDeletionToken())).rejects.toBeInstanceOf(
                InvalidDeletionLinkError,
            );
            await expect(service.inspect('../../etc')).rejects.toBeInstanceOf(InvalidDeletionLinkError);
            await expect(service.claim(undefined)).rejects.toBeInstanceOf(InvalidDeletionLinkError);
        });
    });
});
