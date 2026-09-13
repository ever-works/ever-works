import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes } from 'crypto';
import {
    FLEET_RUN_API_KEY_KIND,
    FLEET_RUN_MCP_SERVER_NAME,
    FLEET_RUN_TOKEN_PREFIX,
    fleetRunTokenExpiryFromLease,
    isFleetRunTokenRouteAllowed,
    type FleetJobMcpCredentialResponse,
} from '@ever-works/contracts';
import { ApiKeyRepository } from '../database/repositories/api-key.repository';
import type { ApiKey } from '../entities/api-key.entity';
import type { FleetJob } from '../entities/fleet-job.entity';
import {
    FleetJobMcpCredentialMintedEvent,
    FleetJobMcpCredentialRevokedEvent,
} from '../events/fleet-job.events';
import { config } from '../config';
import { sha256Hex, verifyNodeSecret } from './fleet-node-credential';
import { FleetJobRepository } from './fleet-job.repository';
import { FleetNodeRepository } from './fleet-node.repository';

/**
 * Self-build slice Z (EW-796) — run-scoped credentials for the fleet MCP
 * bridge.
 *
 * ## The whole life of one token, in one place
 *
 * ```
 *   node holds lease on job J
 *        │  POST /api/fleet/jobs/J/mcp-credential  (node secret)
 *        ▼
 *   mint()  ── 32 random bytes ──▶ raw token  ew_run_<64 hex>
 *        │        │
 *        │        └─ returned ONCE, over the wire, to the node
 *        │
 *        └─ sha256(raw) stored on an api_keys row bound to
 *           { job, run, node, owner, Organization }, expiring at
 *           leaseExpiresAt + grace
 *
 *   … node keeps the raw token in PROCESS MEMORY only …
 *
 *   authenticate(raw) on every API request the MCP server forwards
 *        │  sha256 lookup, kind, isActive, expiry,
 *        │  AND the bound job is still held by the bound node
 *        ▼
 *   revokeForJob(J) at complete / fail / cancel / rotation
 * ```
 *
 * ## Why every refusal collapses to `null`
 *
 * `mint` returns `null` for a node that does not hold the lease, a job
 * that does not exist, a job in a terminal state, a job with a cancel
 * pending, and a job whose payload never asked for a bridge. The
 * controller maps all of them to the SAME undifferentiated 401 the rest
 * of the node channel uses. A differentiated error would let anyone with
 * a valid node secret enumerate which jobs exist and which are active.
 *
 * ## Why `authenticate` re-reads the job
 *
 * Expiry alone is not enough. A lease can be RECLAIMED before it lapses
 * (an operator drains the node, the reclaim sweep hands the job to
 * someone else), and the token would still be inside its window. Binding
 * to `boundNodeId` and re-checking `job.nodeId` means the credential
 * dies the instant the claim it was minted under stops being this
 * node's — which is the same fence `publishFence` puts on the git push.
 */
@Injectable()
export class FleetRunCredentialService {
    private readonly logger = new Logger(FleetRunCredentialService.name);

    /** Job states in which a run may still legitimately call platform tools. */
    private static readonly ACTIVE_STATUSES = new Set(['leased', 'running']);

    constructor(
        private readonly apiKeys: ApiKeyRepository,
        private readonly jobs: FleetJobRepository,
        private readonly nodes: FleetNodeRepository,
        // Appended LAST and @Optional() — the positional-arity rule every
        // other fleet service follows, so specs that build this
        // positionally keep compiling and an install with no event bus
        // simply records nothing.
        @Optional() private readonly events?: EventEmitter2,
    ) {}

    /**
     * Mint a run-scoped credential for the job this node is holding.
     *
     * `null` on ANY refusal — see the class comment for why they are not
     * distinguished. On success the raw token exists exactly twice: in
     * the returned object, and (hashed) on the row.
     */
    async mint(input: {
        nodeId: unknown;
        secret: unknown;
        jobId: string;
    }): Promise<FleetJobMcpCredentialResponse | null> {
        const verified = verifyNodeSecret(input.nodeId, input.secret);
        if (!verified) return null;

        const node = await this.nodes.findById(verified.nodeId);
        if (!node) return null;
        // A drained or still-enrolling node is not authenticated for
        // anything, exactly as `FleetJobService.authenticateNode` decides.
        if (node.status === 'disabled' || node.status === 'enrolling') return null;
        if (!verified.matches(node.enrollmentTokenHash)) return null;

        const job = await this.jobs.findById(input.jobId);
        if (!job) return null;
        // THE authorization: only the node currently holding the claim.
        if (job.nodeId !== node.id) return null;
        if (!FleetRunCredentialService.ACTIVE_STATUSES.has(job.status)) return null;
        // A cancel already requested means the node is about to be told to
        // stop; handing it a fresh credential would widen the window.
        if (job.cancelRequestedAt) return null;
        if (!job.leaseExpiresAt) return null;
        if (!this.bridgeRequested(job)) return null;

        const serverUrl = config.fleetNode.getMcpServerUrl();
        if (!config.fleetNode.isMcpBridgeEnabled() || !serverUrl) {
            // The operator switched the bridge off (or never configured a
            // server) after the job was planned. Refuse rather than mint a
            // credential pointing nowhere.
            return null;
        }

        // Rotation: the node re-mints as its lease is renewed, and at most
        // ONE token per job may ever be live. Deactivating first means a
        // crash between the two writes leaves the job with no credential
        // (fail closed), never with two.
        const rotated = await this.apiKeys.deactivateByBoundJob(job.id);
        if (rotated > 0) {
            this.emit(
                FleetJobMcpCredentialRevokedEvent.EVENT_NAME,
                new FleetJobMcpCredentialRevokedEvent(
                    job.id,
                    rotated,
                    'rotation',
                    this.runIdOf(job),
                ),
            );
        }

        const rawToken = FLEET_RUN_TOKEN_PREFIX + randomBytes(32).toString('hex');
        const expiresAt = fleetRunTokenExpiryFromLease(new Date(job.leaseExpiresAt));
        const runId = this.runIdOf(job);

        await this.apiKeys.create({
            userId: job.userId,
            // Non-secret label. Names the job so an operator reading the
            // table sees WHY the row exists; carries nothing sensitive.
            name: `Fleet run ${job.id}`,
            hashedKey: sha256Hex(rawToken),
            prefix: rawToken.substring(0, 12),
            expiresAt,
            isActive: true,
            kind: FLEET_RUN_API_KEY_KIND,
            boundJobId: job.id,
            boundNodeId: node.id,
            boundRunId: runId,
            // `tenantId` is deliberately NOT stamped here: neither the job
            // nor the node row carries one, and the API-side scope guard
            // already hydrates the owner's tenant from the user row on
            // every request. Inventing a second source would be a second
            // thing to keep in step.
            organizationId: job.organizationId ?? null,
        });

        this.emit(
            FleetJobMcpCredentialMintedEvent.EVENT_NAME,
            new FleetJobMcpCredentialMintedEvent(
                job.id,
                job.userId,
                node.id,
                runId,
                job.organizationId ?? null,
                expiresAt,
                rotated > 0,
            ),
        );
        // The token is NOT in this line and must never be: node id, job
        // id and expiry are the audit facts, the credential is not one.
        this.logger.log(
            `Minted MCP run credential for job ${job.id} (run ${runId ?? 'none'}) on node ${node.id}, expires ${expiresAt.toISOString()}${
                rotated > 0 ? ` [rotated ${rotated}]` : ''
            }`,
        );

        return { token: rawToken, expiresAt: expiresAt.toISOString(), serverUrl };
    }

    /**
     * Node-initiated early revoke, straight after the model step.
     *
     * Node-authenticated and job-scoped like `mint`: a node may only
     * revoke the credentials of a job it holds. Refusals are `null`,
     * mapped to the same 401. The API-side listener revokes again at
     * completion regardless — this path only shortens the window.
     */
    async revokeForNode(input: {
        nodeId: unknown;
        secret: unknown;
        jobId: string;
    }): Promise<number | null> {
        const verified = verifyNodeSecret(input.nodeId, input.secret);
        if (!verified) return null;
        const node = await this.nodes.findById(verified.nodeId);
        if (!node) return null;
        if (node.status === 'enrolling') return null;
        if (!verified.matches(node.enrollmentTokenHash)) return null;

        const job = await this.jobs.findById(input.jobId);
        // A DRAINED node may still revoke: it is settling work it already
        // holds, exactly the posture `authenticateNode('report')` takes.
        if (!job || job.nodeId !== node.id) return null;

        return this.revokeForJob(job.id, 'node-request', this.runIdOf(job));
    }

    /**
     * Revoke every live run credential for a job. Idempotent.
     *
     * The one entry point the completion listener, the node's early
     * revoke and the rotation path all funnel into, so "revoked" means
     * one thing.
     */
    async revokeForJob(
        jobId: string,
        reason: 'rotation' | 'node-request' | 'job-settled' = 'job-settled',
        runId: string | null = null,
    ): Promise<number> {
        const revoked = await this.apiKeys.deactivateByBoundJob(jobId);
        if (revoked > 0) {
            this.emit(
                FleetJobMcpCredentialRevokedEvent.EVENT_NAME,
                new FleetJobMcpCredentialRevokedEvent(jobId, revoked, reason, runId),
            );
            this.logger.log(
                `Revoked ${revoked} MCP run credential(s) for job ${jobId} (${reason})`,
            );
        }
        return revoked;
    }

    /**
     * Validate a presented `ew_run_…` token for one API request.
     *
     * Five independent gates, all of which must hold:
     *   1. the hash resolves to an ACTIVE row (revoke is `isActive`),
     *   2. the row is a `fleet-run` row (a personal key presented with a
     *      run prefix, or vice-versa, is not silently accepted),
     *   3. it has not expired,
     *   4. the request's route is on the run-token allowlist,
     *   5. the bound job is still active AND still held by the bound node.
     *
     * `null` on every failure — the guard maps them all to one 401.
     */
    async authenticate(
        rawToken: string,
        request: { method: string; path: string },
    ): Promise<FleetRunCredentialBinding | null> {
        if (typeof rawToken !== 'string' || !rawToken.startsWith(FLEET_RUN_TOKEN_PREFIX)) {
            return null;
        }
        // Route check FIRST: it needs no database round-trip, and a token
        // aimed at a route it may never reach should cost the platform
        // nothing to refuse.
        if (!isFleetRunTokenRouteAllowed(request.method, request.path)) {
            return null;
        }

        const record = await this.apiKeys.findByHashedKey(sha256Hex(rawToken));
        if (!record) return null;
        if (record.kind !== FLEET_RUN_API_KEY_KIND) return null;
        if (!record.expiresAt || new Date(record.expiresAt) <= new Date()) return null;
        if (!record.boundJobId || !record.boundNodeId) return null;

        const job = await this.jobs.findById(record.boundJobId);
        if (!job) return null;
        if (!FleetRunCredentialService.ACTIVE_STATUSES.has(job.status)) return null;
        // The claim fence: a job reclaimed by another node invalidates
        // every token minted under the old claim, even inside its window.
        if (job.nodeId !== record.boundNodeId) return null;

        this.apiKeys.updateLastUsed(record.id).catch(() => undefined);

        return {
            keyId: record.id,
            userId: record.userId,
            jobId: record.boundJobId,
            nodeId: record.boundNodeId,
            runId: record.boundRunId ?? null,
            tenantId: record.tenantId ?? null,
            organizationId: record.organizationId ?? null,
            expiresAt: new Date(record.expiresAt),
        };
    }

    /** The MCP server name a bridge-enabled run registers the tools under. */
    get serverName(): string {
        return FLEET_RUN_MCP_SERVER_NAME;
    }

    /**
     * Whether the job's own payload asked for the bridge.
     *
     * The payload is written by the planner, never by the node, so this
     * is the platform re-reading its own decision rather than trusting
     * the caller: a node that invents a mint request for a job whose plan
     * never enabled MCP gets nothing.
     */
    private bridgeRequested(job: FleetJob): boolean {
        const payload = job.payload as { mcp?: { enabled?: unknown } } | null | undefined;
        return payload?.mcp?.enabled === true;
    }

    private runIdOf(job: FleetJob): string | null {
        const payload = job.payload as { runId?: unknown } | null | undefined;
        return typeof payload?.runId === 'string' && payload.runId ? payload.runId : null;
    }

    private emit(name: string, event: object): void {
        if (!this.events) return;
        try {
            this.events.emit(name, event);
        } catch (error) {
            // Audit is a side channel; a listener that throws must never
            // cost a run its credential (or leave one un-revoked).
            this.logger.warn(
                `Fleet MCP credential event ${name} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

/**
 * What the API learns from a validated run token.
 *
 * `organizationId` is the load-bearing field: the API-side scope guard
 * pins the request to THIS Organization, and refuses any `X-Scope-Slug`
 * that resolves to a different one. The token's scope wins, and it must
 * equal whatever the caller asked for.
 */
export interface FleetRunCredentialBinding {
    /** `api_keys.id` of the row that authenticated (for `lastUsedAt`). */
    keyId: string;
    /** Owner the run acts as. */
    userId: string;
    jobId: string;
    nodeId: string;
    runId: string | null;
    tenantId: string | null;
    /** Organization the token is pinned to; null = the owner's personal scope. */
    organizationId: string | null;
    expiresAt: Date;
}

/** Re-exported so the API guard can type a partial `ApiKey` row without the entity. */
export type FleetRunApiKeyRow = Pick<
    ApiKey,
    'id' | 'userId' | 'kind' | 'boundJobId' | 'boundNodeId' | 'boundRunId' | 'organizationId'
>;
