import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, MoreThan, QueryFailedError, type EntityManager } from 'typeorm';
import { subjectHash } from '@ever-co/connect-sdk';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import {
    ActivityActionType,
    ActivityStatus,
    AuthSession,
    EverConnectPersonRequest,
    ExternalIdentity,
    type EverConnectPersonRequestKind,
} from '@ever-works/agent/entities';
import { EVER_CONNECT_PLATFORM, type EverConnectPlatform } from './ever-connect-identity.ports';
import {
    EVER_PERSON_DATA_PARTICIPANT,
    type PersonDataParticipant,
    type PersonDataRequest,
} from './person-data-participant.port';
import { describeFailure, platformFailure } from './platform-answer';

/** The feed topics this handler answers. */
export const PERSON_REQUEST_TOPICS: Readonly<Record<string, EverConnectPersonRequestKind>> = {
    'ever.registry.person.deletion_requested': 'deletion',
    'ever.registry.person.export_requested': 'export',
};

/** One event of the installation's feed, as the Ever Connect module receives it. */
export interface PersonRequestEnvelope {
    readonly id: string;
    readonly type: string;
    readonly data: unknown;
}

/** The answer given to one request. `recorded`: Ever Platform has it (or will never take it). */
export interface PersonRequestAnswer {
    readonly jobId: string;
    readonly kind: EverConnectPersonRequestKind;
    readonly result: string;
    readonly reasonCode: string | null;
    readonly recorded: boolean;
}

/** Thrown when the answer could not be delivered: deliver the event again later. */
export class PersonRequestNotAnsweredError extends Error {
    readonly name = 'PersonRequestNotAnsweredError';
    constructor(readonly reason: string) {
        super(`The answer to a person request was not delivered (${reason})`);
    }
}

const JOB_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const IDENTITY_PAGE = 500;

interface Decided {
    result: string;
    reasonCode: string | null;
    legalBasis: string | null;
    exportUrl: string | null;
}

/**
 * Answers Ever Platform's deletion and export requests for a person
 * (`ever.registry.person.deletion_requested|export_requested` on the
 * installation's feed) with `POST /v1/instances/me/ack`.
 *
 * The request names the person by the hashes of their Ever ID identities
 * (`sha256("<issuer>#<subject>")`), never by the subject. The matching local
 * accounts are found through their connected identities:
 *
 * - **Deletion** removes those connected identities (and the sessions they
 *   opened), then the accounts are handed to the person-data participant.
 *   Without a participant the answer is `failed` with `account_deletion_pending`
 *   and the account's Activity records it; never `retained_legal`. Nothing
 *   matched: `no_account`.
 * - **Export** asks the participant for the export address (`exported`);
 *   without one, `failed` with `export_not_available`. Nothing matched:
 *   `no_account`.
 *
 * The answer is decided once per platform job and stored
 * (`ever_connect_person_requests`), so an event delivered again sends the same
 * answer, and only until Ever Platform recorded it.
 */
@Injectable()
export class PersonRequestsHandler {
    private readonly logger = new Logger(PersonRequestsHandler.name);

    constructor(
        @Inject(EVER_CONNECT_PLATFORM) private readonly platform: EverConnectPlatform,
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly activity: ActivityLogService,
        @Optional()
        @Inject(EVER_PERSON_DATA_PARTICIPANT)
        private readonly participant?: PersonDataParticipant,
    ) {}

    /** Whether an event of this type is answered here. */
    handles(type: string): boolean {
        return Object.prototype.hasOwnProperty.call(PERSON_REQUEST_TOPICS, type);
    }

    /**
     * Answer one request. Resolves when Ever Platform recorded the answer, or
     * when it never will (this installation was not asked, another final answer
     * stands, or the answer cannot be sent); `null` for an event that is not a
     * well-formed person request. Rejects with {@link PersonRequestNotAnsweredError}
     * when the answer could not be delivered now.
     */
    async handle(envelope: PersonRequestEnvelope): Promise<PersonRequestAnswer | null> {
        const kind = PERSON_REQUEST_TOPICS[envelope.type];
        if (!kind) return null;
        const request = parseRequest(envelope.data);
        if (!request) {
            this.logger.warn(`Ignoring a malformed ${kind} request (event ${envelope.id})`);
            return null;
        }

        let row = await this.answers().findOne({ where: { jobId: request.jobId } });
        if (!row) row = await this.decide(envelope.id, kind, request);
        if (row.answeredAt) return toAnswer(row, true);
        return this.acknowledge(row);
    }

    private async decide(
        eventId: string,
        kind: EverConnectPersonRequestKind,
        request: ParsedRequest,
    ): Promise<EverConnectPersonRequest> {
        const matches = await this.matchingIdentities(request.hashes);
        const userIds = [...new Set(matches.map((identity) => identity.userId))];
        const participantRequest: PersonDataRequest = {
            userIds,
            jobId: request.jobId,
            respondBy: request.respondBy,
        };

        let decided: Decided;
        if (userIds.length === 0) {
            decided = answer('no_account');
        } else if (kind === 'export') {
            decided = await this.exportAnswer(participantRequest);
        } else {
            decided = await this.deletionAnswer(participantRequest);
        }

        try {
            const row = await this.dataSource.transaction(async (manager) => {
                if (kind === 'deletion' && matches.length > 0) {
                    await this.removeIdentities(
                        manager,
                        matches.map((identity) => identity.id),
                    );
                }
                return manager.getRepository(EverConnectPersonRequest).save(
                    manager.getRepository(EverConnectPersonRequest).create({
                        jobId: request.jobId,
                        eventId,
                        kind,
                        ...decided,
                        answeredAt: null,
                    }),
                );
            });
            if (kind === 'deletion' && decided.reasonCode === 'account_deletion_pending') {
                this.recordPendingDeletion(userIds, request.jobId);
            }
            return row;
        } catch (error) {
            // Another replica answered the same job first: its answer stands.
            if (error instanceof QueryFailedError) {
                const existing = await this.answers().findOne({ where: { jobId: request.jobId } });
                if (existing) return existing;
            }
            throw error;
        }
    }

    private async deletionAnswer(request: PersonDataRequest): Promise<Decided> {
        if (!this.participant) return answer('failed', 'account_deletion_pending');
        try {
            const outcome = await this.participant.deleteAccounts(request);
            if (outcome.result === 'retained_legal') {
                const basis = outcome.legalBasis?.trim() ?? '';
                if (basis.length < 1 || basis.length > 200) {
                    return answer('failed', 'legal_basis_missing');
                }
                return { ...answer('retained_legal'), legalBasis: basis };
            }
            if (outcome.result === 'deleted' || outcome.result === 'anonymised') {
                return answer(outcome.result);
            }
            return answer('failed', 'account_deletion_failed');
        } catch (error) {
            this.logger.warn(`Account deletion for Ever Platform failed: ${errorName(error)}`);
            return answer('failed', 'account_deletion_failed');
        }
    }

    private async exportAnswer(request: PersonDataRequest): Promise<Decided> {
        if (!this.participant) return answer('failed', 'export_not_available');
        try {
            const outcome = await this.participant.exportAccounts(request);
            if (outcome.result === 'exported' && isHttpsUrl(outcome.exportUrl)) {
                return { ...answer('exported'), exportUrl: outcome.exportUrl };
            }
            return answer('failed', 'export_failed');
        } catch (error) {
            this.logger.warn(`Account export for Ever Platform failed: ${errorName(error)}`);
            return answer('failed', 'export_failed');
        }
    }

    /** Send the stored answer; mark it recorded when Ever Platform has it. */
    private async acknowledge(row: EverConnectPersonRequest): Promise<PersonRequestAnswer> {
        const client = await this.platform.client();
        if (!client) throw new PersonRequestNotAnsweredError('not_connected');
        try {
            await client.call('instanceAckRequest', {
                body: {
                    job_id: row.jobId,
                    result: row.result as 'failed',
                    ...(row.reasonCode ? { detail: { reason_code: row.reasonCode } } : {}),
                    ...(row.legalBasis ? { legal_basis: row.legalBasis } : {}),
                    ...(row.exportUrl ? { export_url: row.exportUrl } : {}),
                },
            });
        } catch (error) {
            const failure = platformFailure(error);
            if (failure.kind === 'problem' && (failure.status === 404 || failure.status === 409)) {
                // 404: this installation was not asked for this job. 409
                // `receipt_final`: another final answer is recorded and stands.
                this.logger.warn(`Person request answer not taken: ${describeFailure(failure)}`);
                return this.markRecorded(row);
            }
            if (failure.kind === 'refused' || (failure.kind === 'problem' && failure.status === 422)) {
                // The answer does not fit the contract this build sends; sending it
                // again changes nothing. It stays unrecorded and is logged.
                this.logger.error(`Person request answer refused: ${describeFailure(failure)}`);
                return toAnswer(row, false);
            }
            throw new PersonRequestNotAnsweredError(describeFailure(failure));
        }
        return this.markRecorded(row);
    }

    private async markRecorded(row: EverConnectPersonRequest): Promise<PersonRequestAnswer> {
        await this.answers().update({ id: row.id }, { answeredAt: new Date() });
        return toAnswer(row, true);
    }

    /** The connected identities whose hash is in `hashes` (read page by page). */
    private async matchingIdentities(
        hashes: ReadonlySet<string>,
    ): Promise<Array<Pick<ExternalIdentity, 'id' | 'userId'>>> {
        const found: Array<Pick<ExternalIdentity, 'id' | 'userId'>> = [];
        const repository = this.dataSource.getRepository(ExternalIdentity);
        let after = '';
        for (;;) {
            const page = await repository.find({
                select: { id: true, userId: true, issuer: true, subject: true },
                where: { id: MoreThan(after) },
                order: { id: 'ASC' },
                take: IDENTITY_PAGE,
            });
            for (const identity of page) {
                if (hashes.has(subjectHash(identity.issuer, identity.subject))) {
                    found.push({ id: identity.id, userId: identity.userId });
                }
            }
            if (page.length < IDENTITY_PAGE) return found;
            after = page[page.length - 1].id;
        }
    }

    /** Remove the connected identities and end the sessions they opened. */
    private async removeIdentities(manager: EntityManager, ids: string[]): Promise<void> {
        await manager.getRepository(AuthSession).delete({ externalIdentityId: In(ids) });
        await manager.getRepository(ExternalIdentity).delete({ id: In(ids) });
    }

    /** The account's Activity records that its Ever ID was deleted and the account was not. */
    private recordPendingDeletion(userIds: string[], jobId: string): void {
        for (const userId of userIds) {
            this.activity
                .log({
                    userId,
                    actionType: ActivityActionType.IDENTITY_UNLINKED,
                    action: 'ever_connect.person_deletion.account_pending',
                    status: ActivityStatus.FAILED,
                    summary:
                        'Ever ID deletion: the connected identity was removed; the account is kept until it is deleted here',
                    metadata: { jobId, reasonCode: 'account_deletion_pending' },
                })
                .catch(() => undefined);
        }
    }

    private answers() {
        return this.dataSource.getRepository(EverConnectPersonRequest);
    }
}

interface ParsedRequest {
    jobId: string;
    respondBy: string;
    hashes: ReadonlySet<string>;
}

function parseRequest(data: unknown): ParsedRequest | null {
    if (!data || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    if (typeof record.job_id !== 'string' || !JOB_ID.test(record.job_id)) return null;
    const hashes = new Set<string>();
    const list = Array.isArray(record.subject_hashes) ? record.subject_hashes : [];
    for (const value of [...list, record.subject_hash]) {
        if (typeof value === 'string' && HEX64.test(value)) hashes.add(value);
    }
    return {
        jobId: record.job_id,
        respondBy: typeof record.respond_by === 'string' ? record.respond_by : '',
        hashes,
    };
}

function answer(result: string, reasonCode: string | null = null): Decided {
    return { result, reasonCode, legalBasis: null, exportUrl: null };
}

function toAnswer(row: EverConnectPersonRequest, recorded: boolean): PersonRequestAnswer {
    return {
        jobId: row.jobId,
        kind: row.kind,
        result: row.result,
        reasonCode: row.reasonCode,
        recorded,
    };
}

function isHttpsUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
        return new URL(value).protocol === 'https:';
    } catch {
        return false;
    }
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'unknown';
}
