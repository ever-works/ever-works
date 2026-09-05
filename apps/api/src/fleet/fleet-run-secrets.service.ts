import { Injectable, Logger } from '@nestjs/common';
import {
    FLEET_RUN_ENV_FILE_MAX_CONTENT_BYTES,
    FLEET_RUN_ENV_FILES_MAX_TOTAL_BYTES,
    FLEET_RUN_SECRETS_DECRYPT_FAILED_REASON,
    FLEET_RUN_SECRETS_DISABLED_REASON,
    FLEET_RUN_SECRETS_UNRESOLVED_REASON,
    isValidFleetRunEnvFilePath,
    type FleetJobEnvFilesResponse,
    type FleetRunEnvFileContent,
    type FleetRunEnvFileRequestRef,
} from '@ever-works/contracts';
import { FleetJobService } from '@ever-works/agent/fleet';
import { RepoConnectionRepository } from '@ever-works/agent/database';
import { config } from '@ever-works/agent/config';

/** Envelope marker written by `PluginSecretEncService`. */
const SECRET_ENVELOPE_PREFIX = 'enc::v1::';

/**
 * A refusal the node can act on. Carries a STABLE machine token as its
 * message and nothing else — no path content, no variable name, no crypto
 * detail, no row identity beyond what the node already sent us.
 */
export class FleetRunSecretsError extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'FleetRunSecretsError';
    }
}

/**
 * Run secrets (self-build slice Y, EW-781) — the resolution half of
 * `POST /api/fleet/jobs/:id/env-files`.
 *
 * ## What this service is for
 *
 * A repository's seed `.env` files live envelope-encrypted in the
 * registry and are decrypted only for their owner. The fleet job carries
 * which repository's files a run needs (`workspace.envFilesRef` — row ids
 * and PATHS); the node then asks for the contents HERE, over the same
 * credential-verified channel it uses for lease / heartbeat / complete,
 * and only while it holds the lease on that job.
 *
 * ## The rules this file exists to keep
 *
 * - **Scope comes from the JOB.** `FleetJobService.authorizeRunSecretRequest`
 *   returns the job's `userId`; every registry read is `findByIdAndUser`
 *   with THAT id. A node that names another tenant's connection gets the
 *   same "unresolved" answer as a node naming a row that never existed.
 * - **Fail closed, always.** A missing row, a disabled row, a path the row
 *   does not carry, a decrypt that throws, a value that is still
 *   ciphertext, the instance kill switch — each is a stable reason and an
 *   aborted delivery. There is no partial answer: a run that starts with
 *   half its environment produces a red suite that looks like a code
 *   problem, which is the exact failure this feature removes.
 * - **Nothing is logged about a value.** Log lines name the job and the
 *   reason token. Never a path's content, never a variable name, never a
 *   byte count that would leak length.
 */
@Injectable()
export class FleetRunSecretsService {
    private readonly logger = new Logger(FleetRunSecretsService.name);

    constructor(
        private readonly jobs: FleetJobService,
        private readonly repoConnections: RepoConnectionRepository,
    ) {}

    /**
     * Authorize the caller, then resolve exactly the requested paths.
     *
     * Returns `null` when the node credential / holder / status proof
     * fails, so the controller can answer the SAME undifferentiated 401
     * every other route on this channel answers. A stale lease propagates
     * as `FleetJobStaleLeaseError` (409), exactly as on heartbeat and
     * complete. Everything else throws {@link FleetRunSecretsError}.
     */
    async resolve(input: {
        nodeId: unknown;
        secret: unknown;
        jobId: string;
        leaseGeneration?: unknown;
        refs: readonly FleetRunEnvFileRequestRef[];
    }): Promise<FleetJobEnvFilesResponse | null> {
        const claim = await this.jobs.authorizeRunSecretRequest({
            nodeId: input.nodeId,
            secret: input.secret,
            jobId: input.jobId,
            leaseGeneration: input.leaseGeneration,
        });
        if (!claim) return null;

        if (!config.fleetNode.isRunEnvFilesEnabled()) {
            this.logger.warn(
                `Fleet job ${claim.jobId}: run env-file delivery refused — ${FLEET_RUN_SECRETS_DISABLED_REASON} ` +
                    '(FLEET_NODE_RUN_ENV_FILES is off on this instance)',
            );
            throw new FleetRunSecretsError(FLEET_RUN_SECRETS_DISABLED_REASON);
        }

        const files: FleetRunEnvFileContent[] = [];
        let totalBytes = 0;
        for (const ref of input.refs) {
            const row = await this.loadConnection(claim.jobId, claim.userId, ref.repoConnectionId);
            const stored = row.envFiles ?? {};
            for (const path of ref.paths) {
                // Re-validated on THIS side too. The DTO and the contracts
                // normalizer both check it, and this is the last gate before
                // a path is used as an object key against decrypted data.
                if (!isValidFleetRunEnvFilePath(path)) {
                    throw this.refusal(claim.jobId, FLEET_RUN_SECRETS_UNRESOLVED_REASON);
                }
                const content = stored[path];
                if (typeof content !== 'string') {
                    // The row exists but no longer carries this file: the
                    // operator removed it between planning and running. Fail
                    // rather than deliver a checkout that is missing one.
                    throw this.refusal(claim.jobId, FLEET_RUN_SECRETS_UNRESOLVED_REASON);
                }
                // `PluginSecretEncService.decryptValue` returns a malformed or
                // too-short envelope UNCHANGED rather than throwing (its one
                // soft path). Without this check the node would write
                // ciphertext to `.env`, the suite would fail on a
                // "misconfigured" database, and nothing would say why.
                if (content.startsWith(SECRET_ENVELOPE_PREFIX)) {
                    throw this.refusal(claim.jobId, FLEET_RUN_SECRETS_DECRYPT_FAILED_REASON);
                }
                const bytes = Buffer.byteLength(content, 'utf8');
                if (bytes > FLEET_RUN_ENV_FILE_MAX_CONTENT_BYTES) {
                    throw this.refusal(claim.jobId, FLEET_RUN_SECRETS_UNRESOLVED_REASON);
                }
                totalBytes += bytes;
                if (totalBytes > FLEET_RUN_ENV_FILES_MAX_TOTAL_BYTES) {
                    throw this.refusal(claim.jobId, FLEET_RUN_SECRETS_UNRESOLVED_REASON);
                }
                files.push({ repoConnectionId: ref.repoConnectionId, path, content });
            }
        }
        this.logger.log(
            `Fleet job ${claim.jobId}: delivered ${files.length} run env file(s) to node ${claim.nodeId}`,
        );
        return { files };
    }

    /**
     * The registry row, scoped to the JOB's owner.
     *
     * `envFiles` is an encrypted column with a TypeORM TRANSFORMER, so a
     * corrupt envelope or a missing `PLUGIN_SECRET_ENCRYPTION_KEY` throws
     * from the READ itself, not from anything in this file's body. The
     * try/catch is therefore load-bearing twice over: it maps that throw to
     * a stable reason, and it keeps the raw crypto message (which names the
     * cipher and the row) off the wire.
     */
    private async loadConnection(
        jobId: string,
        userId: string,
        repoConnectionId: string,
    ): Promise<{ envFiles?: Record<string, string> | null }> {
        let row: Awaited<ReturnType<RepoConnectionRepository['findByIdAndUser']>>;
        try {
            row = await this.repoConnections.findByIdAndUser(repoConnectionId, userId);
        } catch (error) {
            this.logger.error(
                `Fleet job ${jobId}: ${FLEET_RUN_SECRETS_DECRYPT_FAILED_REASON} reading repository connection ` +
                    `${repoConnectionId} (${error instanceof Error ? error.name : 'unknown error'})`,
            );
            throw new FleetRunSecretsError(FLEET_RUN_SECRETS_DECRYPT_FAILED_REASON);
        }
        // Missing, someone else's, and disabled collapse to ONE answer — the
        // same posture the registry HTTP surface takes (a row owned by
        // another user reads as nonexistent, never as forbidden).
        if (!row || row.enabled === false) {
            throw this.refusal(jobId, FLEET_RUN_SECRETS_UNRESOLVED_REASON);
        }
        return row;
    }

    /** Log the refusal (job + stable token only) and build the error to throw. */
    private refusal(jobId: string, reason: string): FleetRunSecretsError {
        this.logger.warn(`Fleet job ${jobId}: run env-file delivery refused — ${reason}`);
        return new FleetRunSecretsError(reason);
    }
}
