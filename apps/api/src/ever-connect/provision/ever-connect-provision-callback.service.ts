import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { EverConnectProvisionRecord } from '@ever-works/agent/entities';
import { config } from '../../config/constants';
import { EverConnectLeaseService } from '../ever-connect-lease.service';
import { EverConnectService } from '../ever-connect.service';
import { describeFailure, platformFailure } from '../identity/platform-answer';
import { EverConnectProvisionStore } from './ever-connect-provision.store';

/**
 * The waits between the attempts of a report: a minute, then longer, within a day;
 * after the last attempt the report is given up (`failed`, with its code), and a
 * new request from Ever Platform for the same step opens it again.
 */
export const PROVISION_CALLBACK_RETRY_MS: readonly number[] = Object.freeze([
    60_000,
    5 * 60_000,
    30 * 60_000,
    2 * 3_600_000,
    6 * 3_600_000,
    12 * 3_600_000,
]);

/** How many attempts a report gets. */
export const PROVISION_CALLBACK_MAX_ATTEMPTS = PROVISION_CALLBACK_RETRY_MS.length + 1;

/** How long one attempt holds a report (then another may take it, as for a stopped process). */
const REPORT_LEASE_MS = 2 * 60_000;

/** How many due reports one pass sends at most. */
const REPORT_BATCH = 20;

/** How often the worker looks for due reports. */
const WORKER_ROUND_MS = 60_000;

/** A request is kept a day after it ended (its claims name a person's Ever ID subject). */
export const INTENT_RETENTION_MS = 24 * 3_600_000;

/** A record is kept 30 days after the creation ended (identifiers only). */
export const RECORD_RETENTION_MS = 30 * 24 * 3_600_000;

/** How often what ended is removed. */
const PRUNE_EVERY_MS = 3_600_000;

/** What an id of Ever Platform's (a link) may look like; anything else is not kept. */
const LINK_ID_SHAPE = /^[0-9A-Za-z_-]{8,64}$/;

/**
 * Tells Ever Platform that a company it asked for exists, or that the person
 * declined (`POST /v1/provision-intents/{jti}/complete`, with the installation's
 * own token): the request's `jti`, this installation's id, the tenant, the
 * Organization's slug, the owner's account id and the web app's address of the
 * company. No name, no e-mail. Ever Platform records the link between its
 * organization and the company and answers its id; the person's own link is
 * Ever Platform's to record (it made the request for that person).
 *
 * The first attempt is made right after the company was created. A report that
 * could not be sent (no answer, a 5xx, a 429) is retried by the replica holding
 * the Ever Connect lease. A repeat answers `already_completed`, which counts as
 * done. A refusal (another 4xx) is final and kept as a code; a new request for
 * the same step opens the report again.
 *
 * A report is `sent` only once the link is known here. An answer without a link
 * id looks the link up (`GET /v1/instances/me`); one that finds none stays open
 * and is retried, because nothing else would ever repair it.
 */
@Injectable()
export class EverConnectProvisionCallback implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger('EverConnectProvision');
    private timer: NodeJS.Timeout | null = null;
    private running: Promise<void> | null = null;
    private lastPruneAt = 0;

    constructor(
        private readonly store: EverConnectProvisionStore,
        private readonly connection: EverConnectService,
        private readonly lease: EverConnectLeaseService,
    ) {}

    onModuleInit(): void {
        this.timer = setInterval(() => {
            this.round().catch((error) =>
                this.logger.warn(
                    `A round of company reports failed: ${describeFailure(platformFailure(error))}`,
                ),
            );
        }, WORKER_ROUND_MS);
        this.timer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** One round on the replica holding the lease; `true` when it ran here. */
    async round(now = new Date()): Promise<boolean> {
        if (!(await this.connection.client())) return false;
        if (!(await this.lease.hold(now))) return false;
        await this.sendDue(now);
        return true;
    }

    /** Send every report that is due. Concurrent calls share one pass. */
    sendDue(now = new Date()): Promise<void> {
        if (!this.running) {
            this.running = this.pass(now).finally(() => {
                this.running = null;
            });
        }
        return this.running;
    }

    private async pass(now: Date): Promise<void> {
        for (const record of await this.store.dueReports(REPORT_BATCH, now)) {
            await this.send(record, now);
        }
        if (now.getTime() - this.lastPruneAt >= PRUNE_EVERY_MS) {
            this.lastPruneAt = now.getTime();
            await this.prune(now).catch(() =>
                this.logger.warn('What ended of company creations could not be removed now.'),
            );
        }
    }

    /** Remove the requests and records that ended. */
    async prune(now = new Date()): Promise<void> {
        await this.store.purgeEndedIntents(new Date(now.getTime() - INTENT_RETENTION_MS));
        await this.store.pruneRecords(new Date(now.getTime() - RECORD_RETENTION_MS));
    }

    /** Send one report now (right after the creation); never throws. */
    async sendNow(creationKey: string, now = new Date()): Promise<void> {
        try {
            const record = await this.store.byKey(creationKey);
            if (record?.callbackStatus === 'pending') await this.send(record, now);
        } catch (error) {
            this.logger.warn(
                `A company report could not be sent now (${describeFailure(platformFailure(error))}); it is retried.`,
            );
        }
    }

    private async send(due: EverConnectProvisionRecord, now: Date): Promise<void> {
        const row = await this.connection.connection();
        const client = await this.connection.client();
        // Not connected: the report waits; the lease below is not even taken.
        if (!client || row.status !== 'active' || !row.platformInstanceId) return;
        if (!(await this.store.leaseReport(due, new Date(now.getTime() + REPORT_LEASE_MS), now))) {
            return;
        }
        const record = (await this.store.byKey(due.creationKey)) as EverConnectProvisionRecord;
        const attempts = record.callbackAttempts;
        let linkId = record.platformLinkId;

        if (!record.completedAt) {
            try {
                const answer = await client.connect.completeProvisionIntent(
                    record.intentJti,
                    this.reportBody(record, row.platformInstanceId),
                );
                linkId =
                    typeof answer?.tenant_link_id === 'string' &&
                    LINK_ID_SHAPE.test(answer.tenant_link_id)
                        ? answer.tenant_link_id
                        : null;
            } catch (error) {
                const failure = platformFailure(error);
                if (failure.kind === 'problem' && failure.code === 'credential_revoked') {
                    await this.connection.ended('revoked');
                    return;
                }
                const retryable =
                    failure.kind === 'transient' ||
                    failure.kind === 'rate_limited' ||
                    (failure.kind === 'problem' && failure.status >= 500);
                await this.failed(record, describeFailure(failure), !retryable, now);
                return;
            }
            await this.store.updateReport(record.id, attempts, {
                completedAt: now,
                platformLinkId: linkId,
            });
        }

        // A declined creation made no link: Ever Platform's answer is all there is.
        if (record.status === 'refused') {
            await this.done(record, attempts);
            return;
        }

        if (!linkId) {
            // A repeat (`already_completed`, its first answer lost) may carry no id.
            try {
                linkId = await this.findLink(record);
            } catch (error) {
                await this.failed(
                    record,
                    `link_${describeFailure(platformFailure(error))}`,
                    false,
                    now,
                );
                return;
            }
            if (!linkId) {
                await this.failed(record, 'link_not_found', false, now);
                return;
            }
            await this.store.updateReport(record.id, attempts, { platformLinkId: linkId });
        }
        if (record.organizationId) await this.store.keepLinkId(record.organizationId, linkId);
        await this.done(record, attempts);
    }

    private async done(record: EverConnectProvisionRecord, attempts: number): Promise<void> {
        await this.store.updateReport(record.id, attempts, {
            callbackAttempts: attempts + 1,
            callbackStatus: 'sent',
            nextCallbackAt: null,
            callbackError: null,
        });
        this.logger.log(`ever_connect.provision.reported ${record.intentJti}`);
    }

    /** The body of a report (`IntentComplete`): identifiers and one address, nothing else. */
    private reportBody(record: EverConnectProvisionRecord, instanceId: string) {
        if (record.status === 'refused') {
            return {
                instance_id: instanceId,
                // The contract's value for a refusal: nothing was created.
                product_tenant_id: 'none',
                result: 'refused' as const,
                refusal_reason: 'user_declined',
            };
        }
        const web = config.webAppUrl().replace(/\/+$/, '');
        return {
            instance_id: instanceId,
            product_tenant_id: record.tenantId as string,
            product_org_id: record.organizationSlug as string,
            product_user_ref: record.userId as string,
            urls: { app: `${web}/${record.organizationSlug as string}` },
            result: 'created' as const,
        };
    }

    /**
     * The id of the link Ever Platform recorded for this company
     * (`GET /v1/instances/me`: its organization and the tenant), or `null`.
     */
    private async findLink(record: EverConnectProvisionRecord): Promise<string | null> {
        const client = await this.connection.client();
        if (!client) return null;
        const self = await client.instances.self();
        const link = (self?.tenant_links ?? []).find(
            (candidate) =>
                candidate.org_id === record.everOrgId &&
                candidate.product_tenant_id === record.tenantId &&
                !candidate.unlinked_at &&
                LINK_ID_SHAPE.test(candidate.id),
        );
        return link?.id ?? null;
    }

    /**
     * Count a failed attempt: retried after the next wait, or given up after the last
     * one (or at once, for a refusal of Ever Platform's).
     */
    private async failed(
        record: EverConnectProvisionRecord,
        code: string,
        refused: boolean,
        now: Date,
    ): Promise<void> {
        const next = record.callbackAttempts + 1;
        const final = refused || next >= PROVISION_CALLBACK_MAX_ATTEMPTS;
        const wait =
            PROVISION_CALLBACK_RETRY_MS[Math.min(next, PROVISION_CALLBACK_RETRY_MS.length) - 1];
        await this.store.updateReport(record.id, record.callbackAttempts, {
            callbackAttempts: next,
            callbackStatus: final ? 'failed' : 'pending',
            nextCallbackAt: final ? null : new Date(now.getTime() + wait),
            callbackError: code.replace(/\s+/g, '_').slice(0, 64),
        });
        this.logger.warn(
            final
                ? `ever_connect.provision.callback_failed ${record.intentJti} (${code})`
                : `A company report could not be finished (${code}); it is retried.`,
        );
    }
}
