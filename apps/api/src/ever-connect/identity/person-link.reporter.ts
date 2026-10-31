import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ExternalIdentity } from '@ever-works/agent/entities';
import {
    EverIdIdentityLinkedEvent,
    EverIdIdentityUnlinkedEvent,
    EverIdSignedInEvent,
} from '@ever-works/agent/events';
import {
    EVER_CONNECT_PLATFORM,
    EVER_CONNECT_REPORT_QUEUE,
    EVER_ID_LOGIN_INTEGRATION,
    type EverConnectPlatform,
    type EverConnectReportQueue,
    type EverIdLoginIntegration,
    type PersonLinkReport,
} from './ever-connect-identity.ports';
import { platformFailure } from './platform-answer';

/**
 * The waits between deliveries of a report Ever Platform could not take yet (an
 * outage): up to a day; after the last one the report is given up (`failed`).
 */
export const PERSON_LINK_RETRY_DELAYS_MS = [
    60_000,
    5 * 60_000,
    30 * 60_000,
    2 * 3_600_000,
    6 * 3_600_000,
    24 * 3_600_000,
] as const;

/**
 * The result of one delivery, for the queue that holds the report.
 *
 * - `sent`: Ever Platform has it (also: an unlink of nothing).
 * - `retry`: deliver it again after `afterMs`.
 * - `dropped`: nothing to report any more (not connected, `ever_id_login` off).
 * - `failed`: it will never be accepted (`code` says why).
 */
export type PersonLinkSendOutcome =
    | { readonly outcome: 'sent' }
    | { readonly outcome: 'retry'; readonly afterMs: number; readonly code: string }
    | { readonly outcome: 'dropped'; readonly code: string }
    | { readonly outcome: 'failed'; readonly code: string };

/**
 * Tells Ever Platform which local accounts are linked to an Ever ID
 * (`POST`/`DELETE /v1/instances/me/person-links`), so a person's deletion or
 * export request later reaches this installation.
 *
 * It listens for the connected-identity events of the Ever ID sign-in (an
 * identity connected, used to sign in, or removed) and puts a report on the
 * Ever Connect queue when the installation is connected, `ever_id_login` is on
 * and the identity belongs to Ever Platform's issuer; the queue delivers it
 * through {@link send}. Ever Platform takes a link only for a person who signed
 * in through this installation's own Ever ID client, so a link is reported
 * when it is made and again at each sign-in (the same report again answers the
 * link already recorded): a link made before the client existed is reported at
 * the person's next sign-in. Identifiers only: the local
 * account id, the issuer and subject, how it was linked and the account's
 * tenant — never an e-mail address or a name. Identities created by
 * provisioning are Ever Platform's own and are not reported.
 */
@Injectable()
export class PersonLinkReporter {
    private readonly logger = new Logger(PersonLinkReporter.name);

    constructor(
        @Inject(EVER_CONNECT_PLATFORM) private readonly platform: EverConnectPlatform,
        @Inject(EVER_ID_LOGIN_INTEGRATION) private readonly integration: EverIdLoginIntegration,
        @Inject(EVER_CONNECT_REPORT_QUEUE) private readonly queue: EverConnectReportQueue,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    @OnEvent(EverIdIdentityLinkedEvent.EVENT_NAME, { async: true })
    async onIdentityLinked(event: EverIdIdentityLinkedEvent): Promise<void> {
        if (event.linkedVia === 'provisioning') return;
        await this.queueLink(event.identityId);
    }

    @OnEvent(EverIdSignedInEvent.EVENT_NAME, { async: true })
    async onSignedIn(event: EverIdSignedInEvent): Promise<void> {
        await this.queueLink(event.identityId);
    }

    @OnEvent(EverIdIdentityUnlinkedEvent.EVENT_NAME, { async: true })
    async onIdentityUnlinked(event: EverIdIdentityUnlinkedEvent): Promise<void> {
        try {
            const issuer = await this.reportingIssuer();
            if (!issuer || !event.userId) return;
            // An account keeps at most one identity per issuer: when it still has
            // Ever Platform's, the one removed belonged to another provider.
            const remaining = await this.identities().findOne({
                where: { userId: event.userId, issuer },
            });
            if (remaining) return;
            await this.queue.enqueue({ id: randomUUID(), op: 'unlink', userRef: event.userId });
        } catch (error) {
            this.logger.warn(`Ever ID unlink not queued for Ever Platform: ${errorName(error)}`);
        }
    }

    /**
     * Deliver one report. `attempt` counts the deliveries before this one; the
     * queue keeps the report on `retry` and removes it on any other outcome.
     */
    async send(report: PersonLinkReport, attempt = 0): Promise<PersonLinkSendOutcome> {
        const client = await this.platform.client();
        if (!client) return { outcome: 'dropped', code: 'not_connected' };
        if (!(await this.integration.isEnabled())) {
            return { outcome: 'dropped', code: 'integration_disabled' };
        }
        try {
            if (report.op === 'link') {
                await client.call('instanceCreatePersonLink', {
                    body: {
                        product_user_ref: report.userRef,
                        identity_issuer: report.issuer,
                        identity_subject: report.subject,
                        link_method: report.linkMethod,
                        ...(report.tenantId ? { product_tenant_id: report.tenantId } : {}),
                    },
                });
            } else {
                await client.call('instanceDeletePersonLink', { path: { ref: report.userRef } });
            }
            return { outcome: 'sent' };
        } catch (error) {
            const failure = platformFailure(error);
            switch (failure.kind) {
                case 'rate_limited':
                    return {
                        outcome: 'retry',
                        afterMs: failure.retryAfterS * 1000,
                        code: 'rate_limited',
                    };
                case 'refused':
                    return this.failed(report, failure.code);
                case 'transient':
                    return this.retryOrFail(report, attempt, failure.code);
                case 'problem':
                    // Unlinking what is not linked is done.
                    if (report.op === 'unlink' && failure.status === 404)
                        return { outcome: 'sent' };
                    // `ever_id_login` off, revoked, or the installation disconnected.
                    if (failure.status === 403) return { outcome: 'dropped', code: failure.code };
                    // `subject_unknown` is final for this report: not an Ever ID person,
                    // a person whose deletion started, or one who has not signed in
                    // through this installation's own client (a later sign-in reports again).
                    if (failure.status === 401 || failure.status >= 500) {
                        return this.retryOrFail(report, attempt, failure.code);
                    }
                    return this.failed(report, failure.code);
            }
        }
    }

    /** Queue a link report for one connected identity, when links are reported now. */
    private async queueLink(identityId: string): Promise<void> {
        try {
            const issuer = await this.reportingIssuer();
            if (!issuer) return;
            const identity = await this.identities().findOne({ where: { id: identityId } });
            if (!identity || identity.issuer !== issuer || identity.linkedVia === 'provisioning') {
                return;
            }
            await this.queue.enqueue(linkReport(identity));
        } catch (error) {
            this.logger.warn(`Ever ID link not queued for Ever Platform: ${errorName(error)}`);
        }
    }

    /** The issuer whose links are reported, or `null` when nothing is reported now. */
    private async reportingIssuer(): Promise<string | null> {
        if (!(await this.platform.client())) return null;
        if (!(await this.integration.isEnabled())) return null;
        return (await this.integration.readClient())?.issuer ?? null;
    }

    private retryOrFail(
        report: PersonLinkReport,
        attempt: number,
        code: string,
    ): PersonLinkSendOutcome {
        const afterMs = PERSON_LINK_RETRY_DELAYS_MS[attempt];
        if (afterMs === undefined) return this.failed(report, code);
        return { outcome: 'retry', afterMs, code };
    }

    private failed(report: PersonLinkReport, code: string): PersonLinkSendOutcome {
        this.logger.warn(`Ever ID ${report.op} report given up (${code})`);
        return { outcome: 'failed', code };
    }

    private identities() {
        return this.dataSource.getRepository(ExternalIdentity);
    }
}

function linkReport(identity: ExternalIdentity): PersonLinkReport {
    return {
        id: randomUUID(),
        op: 'link',
        userRef: identity.userId,
        issuer: identity.issuer,
        subject: identity.subject,
        // Every identity a person connects is an explicit link: by signing up
        // with it or by connecting it in Settings.
        linkMethod: 'explicit',
        ...(identity.tenantId ? { tenantId: identity.tenantId } : {}),
    };
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'unknown';
}
