import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, type Repository } from 'typeorm';
import {
    EverConnectLink,
    EverConnectProvisionIntent,
    EverConnectProvisionRecord,
    type EverConnectProvisionSteps,
} from '@ever-works/agent/entities';

/** Another attempt took over a creation this one was running (its claim ended): it stops. */
export class ClaimLostError extends Error {
    constructor() {
        super('Another attempt took over this company creation');
        this.name = 'ClaimLostError';
    }
}

/** What {@link EverConnectProvisionStore.claim} found. */
export type ProvisionClaim =
    | { outcome: 'claimed'; record: EverConnectProvisionRecord }
    | { outcome: 'finished'; record: EverConnectProvisionRecord }
    | { outcome: 'busy'; record: EverConnectProvisionRecord }
    | { outcome: 'replayed' }
    | { outcome: 'org_linked' };

/** What a creation's claim carries. */
export interface ProvisionClaimInput {
    creationKey: string;
    jti: string;
    iat: number;
    everOrgId: string;
    handle: string;
    userId: string;
    idempotencyKey: string;
    bodyHash: string;
}

const FINISHED = ['created', 'partial'];

/** Whether a creation's company exists and its steps are over. */
export function isFinished(record: Pick<EverConnectProvisionRecord, 'status'>): boolean {
    return FINISHED.includes(record.status);
}

/**
 * The tables of creating a company from Ever Platform: the signed requests
 * received (by `jti`), and one record per creation (by the key of Ever Platform's
 * step), with the report to Ever Platform. Every statement here is a
 * compare-and-set on one row, so two replicas agree without a lock.
 */
@Injectable()
export class EverConnectProvisionStore {
    constructor(@InjectDataSource() readonly dataSource: DataSource) {}

    private get intents(): Repository<EverConnectProvisionIntent> {
        return this.dataSource.getRepository(EverConnectProvisionIntent);
    }

    private get records(): Repository<EverConnectProvisionRecord> {
        return this.dataSource.getRepository(EverConnectProvisionRecord);
    }

    /** A column name quoted for the running driver (camelCase columns need quotes on Postgres). */
    private q(name: string): string {
        return this.dataSource.driver.escape(name);
    }

    // ── Requests ─────────────────────────────────────────────────────────────

    /**
     * Keep a verified request. Received again (the person opened the link twice),
     * it keeps its row. Answers `false` when the `jti` is recorded under another
     * key of Ever Platform's.
     */
    async saveIntent(values: {
        jti: string;
        idempotencyKey: string;
        claims: string;
        expiresAt: Date;
    }): Promise<boolean> {
        await this.intents
            .createQueryBuilder()
            .insert()
            .into(EverConnectProvisionIntent)
            .values({ ...values, status: 'pending' })
            .orIgnore()
            .execute();
        const row = await this.intent(values.jti);
        return row?.idempotencyKey === values.idempotencyKey;
    }

    intent(jti: string): Promise<EverConnectProvisionIntent | null> {
        return this.intents.findOne({ where: { jti } });
    }

    async markIntent(
        jti: string,
        status: EverConnectProvisionIntent['status'],
        claims?: string,
    ): Promise<void> {
        await this.intents.update({ jti }, { status, ...(claims ? { claims } : {}) });
    }

    /**
     * Remove the requests that ended before `before` (they name a person's Ever ID
     * subject). One whose report is still open stays until the report ends.
     */
    async purgeEndedIntents(before: Date): Promise<number> {
        const open = this.records
            .createQueryBuilder('record')
            .select('1')
            .where(
                `record.${this.q('intentJti')} = ${this.q('ever_connect_provision_intents')}.${this.q('jti')}`,
            )
            .andWhere(`record.${this.q('callbackStatus')} = 'pending'`);
        const result = await this.intents
            .createQueryBuilder()
            .delete()
            .from(EverConnectProvisionIntent)
            .where(`${this.q('expiresAt')} < :before`, { before })
            .andWhere(`NOT EXISTS (${open.getQuery()})`)
            .execute();
        return result.affected ?? 0;
    }

    /** Remove finished records older than `before` (identifiers only, kept 30 days). */
    async pruneRecords(before: Date): Promise<number> {
        const result = await this.records
            .createQueryBuilder()
            .delete()
            .from(EverConnectProvisionRecord)
            .where(`${this.q('status')} IN (:...statuses)`, {
                statuses: ['created', 'partial', 'refused'],
            })
            .andWhere(`${this.q('updatedAt')} < :before`, { before })
            .andWhere(
                `(${this.q('callbackStatus')} IS NULL OR ${this.q('callbackStatus')} <> 'pending')`,
            )
            .execute();
        return result.affected ?? 0;
    }

    // ── Creations ────────────────────────────────────────────────────────────

    byKey(creationKey: string): Promise<EverConnectProvisionRecord | null> {
        return this.records.findOne({ where: { creationKey } });
    }

    byJti(intentJti: string): Promise<EverConnectProvisionRecord | null> {
        return this.records.findOne({ where: { intentJti } });
    }

    activeLinkOfTenant(tenantId: string): Promise<EverConnectLink | null> {
        return this.dataSource
            .getRepository(EverConnectLink)
            .findOne({ where: { tenantId, status: 'active' } });
    }

    activeLinkOfEverOrg(everOrgId: string): Promise<EverConnectLink | null> {
        return this.dataSource
            .getRepository(EverConnectLink)
            .findOne({ where: { everOrgId, status: 'active' } });
    }

    /**
     * Claim a creation for `holder` until `until`: a new row, or one a failed,
     * declined or stopped attempt left behind. The same key under a new `jti` is
     * Ever Platform's retry of the same step: it takes the creation over and the
     * report names it. Answers who has it: this attempt (`claimed`), a finished
     * creation (`finished`), another attempt within its claim (`busy`), a request
     * used under another key or older than the current one (`replayed`), or
     * another key holding the Ever organization (`org_linked`).
     */
    async claim(
        input: ProvisionClaimInput,
        holder: string,
        until: Date,
        now = new Date(),
    ): Promise<ProvisionClaim> {
        await this.records
            .createQueryBuilder()
            .insert()
            .into(EverConnectProvisionRecord)
            .values({
                creationKey: input.creationKey,
                intentJti: input.jti,
                intentIssuedAt: input.iat,
                idempotencyKey: input.idempotencyKey,
                bodyHash: input.bodyHash,
                everOrgId: input.everOrgId,
                everOrgKey: input.everOrgId,
                handle: input.handle,
                userId: input.userId,
                steps: { cursor: 'none' },
                status: 'pending',
                claimedBy: holder,
                claimedUntil: until,
            })
            .orIgnore()
            .execute();

        const row = await this.byKey(input.creationKey);
        if (!row) {
            // No row under this key: a unique key refused it.
            if (await this.byJti(input.jti)) return { outcome: 'replayed' };
            return (await this.records.findOne({ where: { everOrgKey: input.everOrgId } }))
                ? { outcome: 'org_linked' }
                : { outcome: 'replayed' };
        }
        if (row.claimedBy === holder) return { outcome: 'claimed', record: row };
        if (isFinished(row)) return { outcome: 'finished', record: row };
        if (input.iat < row.intentIssuedAt) return { outcome: 'replayed' };

        let affected = 0;
        try {
            const result = await this.records
                .createQueryBuilder()
                .update(EverConnectProvisionRecord)
                .set({
                    claimedBy: holder,
                    claimedUntil: until,
                    status: 'pending',
                    errorCode: null,
                    intentJti: input.jti,
                    intentIssuedAt: input.iat,
                    idempotencyKey: input.idempotencyKey,
                    bodyHash: input.bodyHash,
                    everOrgKey: input.everOrgId,
                    userId: input.userId,
                    // A declined one's report is over: this attempt reports afresh.
                    callbackStatus: null,
                    callbackAttempts: 0,
                    nextCallbackAt: null,
                    callbackError: null,
                    completedAt: null,
                })
                .where(`${this.q('creationKey')} = :key`, { key: input.creationKey })
                .andWhere(`${this.q('status')} NOT IN (:...finished)`, { finished: FINISHED })
                .andWhere(
                    `(${this.q('claimedUntil')} IS NULL OR ${this.q('claimedUntil')} < :now)`,
                    { now },
                )
                .execute();
            affected = result.affected ?? 0;
        } catch {
            // A unique key refused the move: the `jti` was used under another key,
            // or another key took the Ever organization while this one had failed.
            const byJti = await this.byJti(input.jti);
            if (byJti && byJti.creationKey !== input.creationKey) return { outcome: 'replayed' };
            return { outcome: 'org_linked' };
        }
        const current = (await this.byKey(input.creationKey)) as EverConnectProvisionRecord;
        if (affected > 0 && current.claimedBy === holder) {
            return { outcome: 'claimed', record: current };
        }
        return isFinished(current)
            ? { outcome: 'finished', record: current }
            : { outcome: 'busy', record: current };
    }

    /**
     * Keep what a step made and renew the claim, only while `holder` still has it.
     * @throws ClaimLostError when another attempt took the creation over.
     */
    async checkpoint(
        id: string,
        holder: string,
        values: Partial<EverConnectProvisionRecord>,
        until: Date,
    ): Promise<void> {
        const result = await this.records.update({ id, claimedBy: holder }, {
            ...values,
            claimedUntil: until,
        } as object);
        if ((result.affected ?? 0) === 0) throw new ClaimLostError();
    }

    /**
     * Inside the core's transaction: the record, locked, must still be `holder`'s.
     * @throws ClaimLostError
     */
    async assertClaim(manager: EntityManager, id: string, holder: string): Promise<void> {
        const lock =
            this.dataSource.options.type === 'postgres'
                ? { lock: { mode: 'pessimistic_write' as const } }
                : {};
        const row = await manager
            .getRepository(EverConnectProvisionRecord)
            .findOne({ where: { id }, ...lock });
        if (row?.claimedBy !== holder) throw new ClaimLostError();
    }

    /** A failed attempt ends: the row stays for a retry; the Ever organization is free again. */
    async fail(id: string, holder: string, errorCode: string): Promise<void> {
        await this.records.update(
            { id, claimedBy: holder },
            {
                status: 'failed',
                errorCode: errorCode.slice(0, 64),
                claimedBy: null,
                claimedUntil: null,
                everOrgKey: null,
            },
        );
    }

    /** The steps are over: the company exists and the report is due now. */
    async finish(
        id: string,
        holder: string,
        status: 'created' | 'partial',
        steps: EverConnectProvisionSteps,
        now = new Date(),
    ): Promise<void> {
        const result = await this.records.update({ id, claimedBy: holder }, {
            status,
            steps,
            errorCode: null,
            claimedBy: null,
            claimedUntil: null,
            callbackStatus: 'pending',
            callbackAttempts: 0,
            nextCallbackAt: now,
            callbackError: null,
        } as object);
        if ((result.affected ?? 0) === 0) throw new ClaimLostError();
    }

    /** The person declined: nothing is created, and Ever Platform is told. */
    async refuse(input: {
        creationKey: string;
        jti: string;
        iat: number;
        everOrgId: string;
        handle: string;
        userId: string;
        now?: Date;
    }): Promise<EverConnectProvisionRecord | null> {
        const now = input.now ?? new Date();
        await this.records
            .createQueryBuilder()
            .insert()
            .into(EverConnectProvisionRecord)
            .values({
                creationKey: input.creationKey,
                intentJti: input.jti,
                intentIssuedAt: input.iat,
                everOrgId: input.everOrgId,
                handle: input.handle,
                userId: input.userId,
                steps: { cursor: 'none' },
                status: 'refused',
                callbackStatus: 'pending',
                nextCallbackAt: now,
            })
            .orIgnore()
            .execute();
        const row = await this.byKey(input.creationKey);
        if (!row) return null;
        // A creation that made nothing yet can be declined; one that did cannot.
        if (row.status === 'refused') return row;
        if (row.steps?.cursor !== 'none' || isFinished(row)) return null;
        const result = await this.records
            .createQueryBuilder()
            .update(EverConnectProvisionRecord)
            .set({
                status: 'refused',
                intentJti: input.jti,
                intentIssuedAt: input.iat,
                everOrgKey: null,
                claimedBy: null,
                claimedUntil: null,
                callbackStatus: 'pending',
                callbackAttempts: 0,
                nextCallbackAt: now,
                callbackError: null,
                completedAt: null,
            })
            .where(`${this.q('id')} = :id`, { id: row.id })
            .andWhere(`(${this.q('claimedUntil')} IS NULL OR ${this.q('claimedUntil')} < :now)`, {
                now,
            })
            .execute();
        return (result.affected ?? 0) > 0 ? this.byKey(input.creationKey) : null;
    }

    // ── Reports ──────────────────────────────────────────────────────────────

    /**
     * Ever Platform asks again (a new request for the same step) for a company that
     * exists and whose report it has not answered: the report now names the new
     * request and is due at once. Answers whether it did: never once Ever Platform
     * answered it.
     */
    async reportUnder(id: string, jti: string, iat: number, now = new Date()): Promise<boolean> {
        const result = await this.records
            .createQueryBuilder()
            .update(EverConnectProvisionRecord)
            .set({
                intentJti: jti,
                intentIssuedAt: iat,
                callbackStatus: 'pending',
                callbackAttempts: 0,
                nextCallbackAt: now,
                callbackError: null,
            })
            .where(`${this.q('id')} = :id`, { id })
            .andWhere(`${this.q('completedAt')} IS NULL`)
            .andWhere(`${this.q('intentJti')} <> :jti`, { jti })
            .andWhere(`${this.q('intentIssuedAt')} <= :iat`, { iat })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /** Reports that are due, oldest first. */
    dueReports(limit: number, now = new Date()): Promise<EverConnectProvisionRecord[]> {
        return this.records
            .createQueryBuilder('record')
            .where(`record.${this.q('callbackStatus')} = 'pending'`)
            .andWhere(
                `(record.${this.q('nextCallbackAt')} IS NULL OR record.${this.q('nextCallbackAt')} <= :now)`,
                { now },
            )
            .orderBy(`record.${this.q('createdAt')}`, 'ASC')
            .limit(limit)
            .getMany();
    }

    /**
     * Take the next attempt of a report for `until` (an attempt that stops is retried
     * when it ends), only while the report is as the caller read it and due. Two
     * callers (the request right after the creation, the worker) never send one
     * report at once.
     */
    async leaseReport(
        record: EverConnectProvisionRecord,
        until: Date,
        now = new Date(),
    ): Promise<boolean> {
        const result = await this.records
            .createQueryBuilder()
            .update(EverConnectProvisionRecord)
            .set({ nextCallbackAt: until })
            .where(`${this.q('id')} = :id`, { id: record.id })
            .andWhere(`${this.q('callbackStatus')} = 'pending'`)
            .andWhere(`${this.q('callbackAttempts')} = :attempts`, {
                attempts: record.callbackAttempts,
            })
            .andWhere(
                `(${this.q('nextCallbackAt')} IS NULL OR ${this.q('nextCallbackAt')} <= :now)`,
                { now },
            )
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /** Update a report only while it is in the state the caller read. */
    async updateReport(
        id: string,
        attempts: number,
        values: Partial<EverConnectProvisionRecord>,
    ): Promise<boolean> {
        const result = await this.records.update(
            { id, callbackAttempts: attempts, callbackStatus: 'pending' },
            values as object,
        );
        return (result.affected ?? 0) > 0;
    }

    /** Keep Ever Platform's id of the link on this installation's own. */
    async keepLinkId(organizationId: string, platformLinkId: string): Promise<void> {
        await this.dataSource
            .getRepository(EverConnectLink)
            .update({ organizationId }, { platformLinkId });
    }
}
