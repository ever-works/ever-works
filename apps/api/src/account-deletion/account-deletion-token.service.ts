import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AccountDeletionRequest } from '@ever-works/agent/entities';
import { AccountDeletionRequestStore } from './account-deletion-request.store';
import {
    ACCOUNT_DELETION_MAX_REQUESTS_PER_EMAIL_PER_HOUR,
    buildDeletionLink,
    emailLogRef,
    generateDeletionToken,
    hashDeletionEmail,
    hashDeletionToken,
    isWellFormedDeletionToken,
    normaliseDeletionEmail,
    resolveDeletionTokenTtlMinutes,
} from './account-deletion.tokens';

/** The account a link is issued for — only what the email needs. */
export interface DeletionLinkRecipient {
    id: string;
    email: string;
    username: string | null;
}

/** Looks an address up among accounts that can receive a link. */
export abstract class DeletionRecipientLookup {
    abstract findByEmail(normalisedEmail: string): Promise<DeletionLinkRecipient | null>;
}

/** Sends the link email; throws when it was not sent. */
export abstract class DeletionLinkSender {
    abstract send(input: {
        to: string;
        firstName: string | null;
        deleteUrl: string;
        keepAccountUrl: string;
        expiresInMinutes: number;
    }): Promise<void>;
}

export interface DeletionLinkUrls {
    /** The web confirm page the link opens when the caller names none (or one we do not serve). */
    defaultConfirmUrl: string;
    /** Where "Keep my account" points. */
    keepAccountUrl: string;
    /** Hosts a caller-supplied `callbackUrl` may point at. */
    allowedCallbackHosts: ReadonlySet<string>;
}

export interface DeletionRequestInput {
    email: string;
    callbackUrl?: string | null;
}

/** What the background issuance did — for tests and hashed logs only, never the HTTP response. */
export type DeletionIssueOutcome =
    | 'sent'
    | 'no-account'
    | 'rate-limited'
    | 'invalid'
    | 'send-failed';

/** Raised for every unusable link: unknown, malformed, used, expired or revoked. */
export class InvalidDeletionLinkError extends Error {
    constructor() {
        super('invalid_deletion_link');
        this.name = 'InvalidDeletionLinkError';
    }
}

export const DELETION_LINK_URLS = Symbol('DELETION_LINK_URLS');
export const DELETION_SCHEDULER = Symbol('DELETION_SCHEDULER');
export const DELETION_CLOCK = Symbol('DELETION_CLOCK');

/** Runs a task after the current request has been answered. */
export type DeletionScheduler = (task: () => Promise<void>) => void;
export type DeletionClock = () => Date;

const LOOSE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The email-link half of self-serve deletion: issue, inspect, claim.
 *
 * Security rules this class owns (unit-tested in
 * `account-deletion-token.service.spec.ts`):
 * - the token is 32 random bytes (base64url); only `sha256(token)` is stored;
 * - a link lives `ACCOUNT_DELETION_TOKEN_TTL_MINUTES` (30, clamped 5..60);
 * - a new request revokes the address's earlier unused links;
 * - {@link claim} is a single conditional UPDATE — one winner, ever;
 * - {@link acceptRequest} answers the same thing for every address and does
 *   the lookup, the rate limit and the send only after the caller has its
 *   answer; at most 3 links per address per hour;
 * - the token and the address are never logged (a hash handle at most).
 */
@Injectable()
export class AccountDeletionTokenService {
    private readonly logger = new Logger(AccountDeletionTokenService.name);
    readonly ttlMinutes = resolveDeletionTokenTtlMinutes();

    constructor(
        private readonly store: AccountDeletionRequestStore,
        private readonly recipients: DeletionRecipientLookup,
        private readonly sender: DeletionLinkSender,
        @Inject(DELETION_LINK_URLS) private readonly urls: DeletionLinkUrls,
        @Inject(DELETION_SCHEDULER) private readonly schedule: DeletionScheduler,
        @Optional() @Inject(DELETION_CLOCK) clock?: DeletionClock,
    ) {
        this.now = clock ?? (() => new Date());
    }

    private readonly now: DeletionClock;

    /**
     * The public request. Always the same answer; the real work runs after it.
     */
    acceptRequest(input: DeletionRequestInput): { status: 'accepted' } {
        const snapshot: DeletionRequestInput = {
            email: typeof input?.email === 'string' ? input.email : '',
            callbackUrl: typeof input?.callbackUrl === 'string' ? input.callbackUrl : null,
        };
        this.schedule(async () => {
            try {
                const outcome = await this.issue(snapshot);
                this.logger.log(`account-deletion request ${this.ref(snapshot.email)}: ${outcome}`);
            } catch (error) {
                this.logger.error(
                    `account-deletion request ${this.ref(snapshot.email)} failed (${
                        error instanceof Error ? error.name : 'error'
                    })`,
                );
            }
        });
        return { status: 'accepted' };
    }

    /** Issue a link now. Exposed for the scheduler and the tests; never returned over HTTP. */
    async issue(input: DeletionRequestInput): Promise<DeletionIssueOutcome> {
        const raw = (input.email ?? '').trim();
        if (!raw || raw.length > 320 || !LOOSE_EMAIL.test(raw)) {
            return 'invalid';
        }
        const email = normaliseDeletionEmail(raw);
        const emailHash = hashDeletionEmail(email);
        const now = this.now();

        const since = new Date(now.getTime() - 60 * 60 * 1000);
        if (
            (await this.store.countIssuedSince(emailHash, since)) >=
            ACCOUNT_DELETION_MAX_REQUESTS_PER_EMAIL_PER_HOUR
        ) {
            return 'rate-limited';
        }

        const recipient = await this.recipients.findByEmail(email);
        if (!recipient) {
            return 'no-account';
        }

        await this.store.revokePending(emailHash);

        const token = generateDeletionToken();
        const row = await this.store.insert({
            source: 'email_link',
            emailHash,
            tokenHash: hashDeletionToken(token),
            userId: recipient.id,
            status: 'pending',
            expiresAt: new Date(now.getTime() + this.ttlMinutes * 60 * 1000),
        });

        try {
            await this.sender.send({
                to: recipient.email,
                firstName: recipient.username,
                deleteUrl: buildDeletionLink(this.resolveConfirmUrl(input.callbackUrl), token),
                keepAccountUrl: this.urls.keepAccountUrl,
                expiresInMinutes: this.ttlMinutes,
            });
        } catch {
            // The token reached nobody — retire it so it cannot linger.
            await this.store.update(row.id, { status: 'failed', failureCode: 'mail_failed' });
            return 'send-failed';
        }
        return 'sent';
    }

    /** Verify a link WITHOUT using it. */
    async inspect(token: unknown): Promise<AccountDeletionRequest> {
        if (!isWellFormedDeletionToken(token)) {
            throw new InvalidDeletionLinkError();
        }
        const row = await this.store.findByTokenHash(hashDeletionToken(token));
        if (!this.isLive(row)) {
            throw new InvalidDeletionLinkError();
        }
        return row as AccountDeletionRequest;
    }

    /**
     * Use a link: the atomic claim. Returns the claimed row; every loser —
     * concurrent, repeated, expired, revoked, unknown — gets the same error.
     */
    async claim(token: unknown): Promise<AccountDeletionRequest> {
        if (!isWellFormedDeletionToken(token)) {
            throw new InvalidDeletionLinkError();
        }
        const tokenHash = hashDeletionToken(token);
        const won = await this.store.claim(tokenHash, this.now());
        if (!won) {
            throw new InvalidDeletionLinkError();
        }
        const row = await this.store.findByTokenHash(tokenHash);
        if (!row) {
            throw new InvalidDeletionLinkError();
        }
        return row;
    }

    private isLive(row: AccountDeletionRequest | null): boolean {
        if (!row || row.status !== 'pending' || !row.expiresAt) return false;
        return new Date(row.expiresAt).getTime() > this.now().getTime();
    }

    /**
     * A caller may name its own confirm page (the ever.co fan-out, another
     * front end) only on a host this deployment serves; anything else gets
     * the platform's own page.
     */
    resolveConfirmUrl(callbackUrl: string | null | undefined): string {
        if (!callbackUrl) return this.urls.defaultConfirmUrl;
        let parsed: URL;
        try {
            parsed = new URL(callbackUrl);
        } catch {
            return this.urls.defaultConfirmUrl;
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            return this.urls.defaultConfirmUrl;
        }
        if (parsed.username || parsed.password) {
            return this.urls.defaultConfirmUrl;
        }
        if (!this.urls.allowedCallbackHosts.has(parsed.host.toLowerCase())) {
            return this.urls.defaultConfirmUrl;
        }
        // Drop any fragment-borne token a caller tried to smuggle in; keep the route.
        return callbackUrl.replace(/([#?&])token=[^&#]*/g, '$1').replace(/[?&#]$/, '');
    }

    private ref(email: string): string {
        return email ? emailLogRef(email) : 'email#none';
    }
}
