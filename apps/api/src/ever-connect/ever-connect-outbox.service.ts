import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, MoreThan, type Repository } from 'typeorm';
import { EverConnectOutbox } from '@ever-works/agent/entities';
import { EverConnectConnectionChangedEvent } from './ever-connect.events';
import type {
    EverConnectReportQueue,
    PersonLinkReport,
} from './identity/ever-connect-identity.ports';
import { PersonLinkReporter } from './identity/person-link.reporter';

/** The outbox event of a person-link report. */
export const PERSON_LINK_EVENT = 'person_link';

/** How many rows one pass of the worker reads. */
const PASS_SIZE = 100;

let seqCounter = 0;

/** The write order of a report: milliseconds × 1000 plus a counter (finer than `createdAt`). */
function nextSeq(): string {
    seqCounter = (seqCounter + 1) % 1000;
    return String(Date.now() * 1000 + seqCounter);
}

/** What the operator sees of the outbox. */
export interface EverConnectOutboxStatus {
    readonly pending: number;
    readonly failed: number;
    readonly lastError: string | null;
}

/**
 * The Ever Connect outbox: reports owed to Ever Platform, kept in
 * `ever_connect_outbox` until delivered. {@link enqueue} is the report queue
 * the person-link reporter writes to.
 */
@Injectable()
export class EverConnectOutboxService implements EverConnectReportQueue {
    constructor(
        @InjectRepository(EverConnectOutbox) private readonly outbox: Repository<EverConnectOutbox>,
    ) {}

    async enqueue(report: PersonLinkReport): Promise<void> {
        await this.outbox
            .createQueryBuilder()
            .insert()
            .into(EverConnectOutbox)
            .values({
                event: PERSON_LINK_EVENT,
                payload: report as unknown as Record<string, unknown>,
                dedupeKey: `${PERSON_LINK_EVENT}:${report.id}`,
                seq: nextSeq(),
                accountRef: report.userRef,
                state: 'pending',
                attempts: 0,
                nextAttemptAt: new Date(),
            })
            .orIgnore()
            .execute();
    }

    async status(): Promise<EverConnectOutboxStatus> {
        const pending = await this.outbox.count({ where: { state: 'pending' } });
        const failed = await this.outbox.count({ where: { state: 'failed' } });
        const last = await this.outbox.findOne({
            where: { state: In(['pending', 'failed']) },
            order: { updatedAt: 'DESC' },
        });
        return { pending, failed, lastError: last?.lastError ?? null };
    }

    /** The connection ended: Ever Platform unlinks the installation's links itself. */
    @OnEvent(EverConnectConnectionChangedEvent.EVENT_NAME, { async: true })
    async onConnectionChanged(event: EverConnectConnectionChangedEvent): Promise<void> {
        if (event.status !== 'disconnected' && event.status !== 'revoked') return;
        await this.outbox.delete({ state: 'pending' }).catch(() => undefined);
    }
}

/**
 * Sends the outbox, oldest first, on the replica holding the Ever Connect
 * lease. Reports about one account are delivered in the order they were made:
 * while an earlier one waits for a retry, later ones wait too. A delivered or
 * dropped report is removed; a refused one stays as `failed` for the operator.
 */
@Injectable()
export class EverConnectOutboxWorker {
    private readonly logger = new Logger(EverConnectOutboxWorker.name);

    constructor(
        @InjectRepository(EverConnectOutbox) private readonly outbox: Repository<EverConnectOutbox>,
        private readonly reporter: PersonLinkReporter,
    ) {}

    /** One pass. Returns how many reports were delivered. */
    async drainOnce(now = new Date()): Promise<number> {
        // Only due rows: reports waiting for a retry never hold up the others.
        const rows = await this.outbox.find({
            where: {
                state: 'pending',
                event: PERSON_LINK_EVENT,
                nextAttemptAt: LessThanOrEqual(now),
            },
            order: { seq: 'ASC', createdAt: 'ASC' },
            take: PASS_SIZE,
        });
        if (rows.length === 0) return 0;

        // An account's reports wait behind its earliest report that is not due yet.
        const waitingFrom = new Map<string, bigint>();
        const accounts = [...new Set(rows.map((row) => accountOf(row)))];
        const notDue = await this.outbox.find({
            select: { id: true, accountRef: true, seq: true },
            where: {
                state: 'pending',
                event: PERSON_LINK_EVENT,
                accountRef: In(accounts),
                nextAttemptAt: MoreThan(now),
            },
        });
        for (const row of notDue) {
            const account = row.accountRef as string;
            const seq = BigInt(String(row.seq));
            const current = waitingFrom.get(account);
            if (current === undefined || seq < current) waitingFrom.set(account, seq);
        }

        let sent = 0;
        for (const row of rows) {
            const report = row.payload as unknown as PersonLinkReport;
            const account = accountOf(row);
            const seq = BigInt(String(row.seq));
            const blockedFrom = waitingFrom.get(account);
            if (blockedFrom !== undefined && seq > blockedFrom) continue;
            const outcome = await this.reporter.send(report, row.attempts);
            switch (outcome.outcome) {
                case 'sent':
                    sent += 1;
                    await this.outbox.delete({ id: row.id });
                    break;
                case 'dropped':
                    await this.outbox.delete({ id: row.id });
                    break;
                case 'failed':
                    await this.outbox.update(
                        { id: row.id },
                        { state: 'failed', attempts: row.attempts + 1, lastError: outcome.code },
                    );
                    break;
                case 'retry':
                    if (blockedFrom === undefined || seq < blockedFrom) {
                        waitingFrom.set(account, seq);
                    }
                    await this.outbox.update(
                        { id: row.id },
                        {
                            attempts: row.attempts + 1,
                            nextAttemptAt: new Date(now.getTime() + outcome.afterMs),
                            lastError: outcome.code,
                        },
                    );
                    break;
            }
        }
        if (sent > 0) this.logger.debug(`Delivered ${sent} Ever ID link report(s)`);
        return sent;
    }
}

/** The account a row is about (its column, or the report for a row written without it). */
function accountOf(row: EverConnectOutbox): string {
    return row.accountRef ?? (row.payload as unknown as PersonLinkReport).userRef;
}
