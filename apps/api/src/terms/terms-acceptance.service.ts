import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import {
    TermsAcceptanceService as Recorder,
    assertPublishedText,
    type AcceptanceMethod,
    type AcceptanceRecord,
    type RequiredDocument,
} from 'terms-acceptance';
import { BetterAuthAcceptanceAdapter } from 'terms-acceptance/better-auth';
import type { BetterAuthDatabase } from 'terms-acceptance/better-auth';
import { AUTH_RUNTIME_INSTANCE } from '../auth/providers/auth-provider.constants';
import type { createAuthRuntimeInstance } from '../auth/providers/auth-runtime.instance';
import {
    TERMS_ACCEPTANCE_MODEL,
    corpus,
    getRequiredTermsDocuments,
} from './terms-acceptance.corpus';

/** One document a signup form says it displayed. */
export interface TermsAcceptanceClaim {
    documentId: string;
    version: string;
    sha256: string;
    locale: string;
}

/**
 * Records terms-of-service acceptance at signup.
 *
 * ## What this fixes
 *
 * `register-form.tsx` rendered an uncontrolled
 * `<input id="terms" type="checkbox" required>`. It never appeared in
 * `formData`, the `register` server action never referenced it, and `RegisterDto`
 * had no field for it. HTML5 `required` stopped the submit and nothing else
 * happened — the appearance of consent with none of the evidence.
 *
 * ## Writes go through Better Auth
 *
 * `BetterAuthAcceptanceAdapter` writes through Better Auth's own database layer,
 * so acceptance rows inherit exactly the driver, pooling and connection handling
 * the rest of auth already uses — the same pool this app extracts from the
 * TypeORM DataSource. The adapter is built lazily because `auth.$context`
 * resolves asynchronously.
 *
 * ## Claims are checked before they become evidence
 *
 * The digest arrives from a browser, so it is a *claim*. Constructing the
 * recorder with `corpus` routes every write through `assertPublishedText`: an
 * acceptance can never point at text `@ever-co/legal` never published. A forged
 * or stale request fails loudly instead of writing a row that means nothing.
 */
@Injectable()
export class TermsAcceptanceService {
    private readonly logger = new Logger(TermsAcceptanceService.name);
    private recorder: Promise<Recorder> | null = null;

    constructor(
        @Inject(AUTH_RUNTIME_INSTANCE)
        private readonly auth: ReturnType<typeof createAuthRuntimeInstance>,
    ) {}

    /**
     * The documents a new account must accept, as currently published.
     *
     * Served to the signup form so the client never guesses a version or a
     * digest, and so the object that gates the submit button is the object that
     * gets posted back.
     */
    getRequiredDocuments(locale?: string): RequiredDocument[] {
        return getRequiredTermsDocuments(locale);
    }

    /**
     * Validate claims *before* the account is created.
     *
     * Rejecting here rather than after `signUpEmail` means a malformed or
     * unpublished claim never leaves a half-created user behind — the caller
     * would otherwise retry and be told the email is already taken.
     * `assertPublishedText` is pure and synchronous, so this is cheap.
     *
     * @throws BadRequestException when a claim does not match published text.
     */
    assertClaimsArePublished(claims: TermsAcceptanceClaim[]): void {
        for (const claim of claims) {
            try {
                assertPublishedText(corpus, claim.documentId, claim.version, claim.sha256);
            } catch (error) {
                this.logger.warn(
                    `Rejected terms acceptance for unpublished text: ${claim.documentId}@${claim.version} — ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                throw new BadRequestException(
                    `Terms acceptance references text that was never published: ${claim.documentId}@${claim.version}.`,
                );
            }
        }
    }

    /**
     * Record the acceptance the signup form collected.
     *
     * Idempotent per `(user, document, version)` — the unique index added by
     * 1785000000000-CreateTermsAcceptance is what enforces it — so a
     * double-submitted form returns the existing row instead of producing two
     * records that disagree about the time.
     */
    async record(
        userId: string,
        claims: TermsAcceptanceClaim[],
        context: {
            method: AcceptanceMethod;
            ip?: string | null;
            userAgent?: string | null;
            tenantId?: string | null;
        },
    ): Promise<AcceptanceRecord[]> {
        const recorder = await this.getRecorder();

        const documents: RequiredDocument[] = claims.map(
            ({ documentId, version, sha256, locale }) => ({
                documentId,
                version,
                sha256,
                locale,
            }),
        );

        return recorder.recordMany(documents, {
            subjectId: userId,
            tenantId: context.tenantId ?? null,
            method: context.method,
            // Salted and digested; the address itself is never stored. Without
            // TERMS_IP_SALT this is null and no IP is recorded at all, which is
            // a legitimate configuration — an *unsalted* IP hash would not be,
            // since all 2^32 IPv4 addresses can be enumerated in seconds.
            ipHash: recorder.hashIp(context.ip),
            userAgent: context.userAgent ?? null,
        });
    }

    /** Every acceptance on file for a user, newest first, integrity-checked. */
    async history(userId: string): Promise<AcceptanceRecord[]> {
        const recorder = await this.getRecorder();
        return recorder.history({ subjectId: userId });
    }

    /**
     * Build the recorder once, against Better Auth's internal database adapter.
     *
     * `auth.$context` is a promise, so this cannot happen in the constructor.
     * The promise itself is memoised rather than the resolved value so
     * concurrent registrations during startup share one initialisation.
     */
    private getRecorder(): Promise<Recorder> {
        if (!this.recorder) {
            this.recorder = (async () => {
                const context = await this.auth.$context;

                return new Recorder({
                    adapter: new BetterAuthAcceptanceAdapter({
                        database: context.adapter as unknown as BetterAuthDatabase,
                        model: TERMS_ACCEPTANCE_MODEL,
                    }),
                    // Every write is checked against the published corpus.
                    corpus,
                    ipSalt: process.env.TERMS_IP_SALT,
                    // `materiality` stays at the default `'declared-or-semver'`:
                    // the corpus does not yet declare a per-document `history`,
                    // and `'declared'` would throw on every status check until
                    // it does.
                });
            })();
        }

        return this.recorder;
    }
}
