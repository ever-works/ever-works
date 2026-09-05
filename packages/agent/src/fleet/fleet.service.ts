import { randomBytes } from 'crypto';
import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import type { IPlugin } from '@ever-works/plugin';
import {
    FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS,
    FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH,
    FLEET_DEFAULT_MAX_CAPABILITY_TAGS,
    FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS,
    FLEET_ENROLLABLE_NODE_KINDS,
    FLEET_MAX_CLI_VERSION_LENGTH,
    FLEET_MAX_DISK_FREE_BYTES,
    FLEET_MAX_MODEL_IDENTITY_LENGTH,
    FLEET_MAX_NODE_NAME_LENGTH,
    FLEET_MAX_PLATFORM_LENGTH,
    FLEET_MAX_VERSION_LENGTH,
    FLEET_MIN_NODE_NAME_LENGTH,
} from '@ever-works/contracts';
import type { FleetNodeView, FleetNodeLoadView } from '@ever-works/contracts';
import { config } from '../config';
import {
    FleetNode,
    FleetNodeKind,
    FleetNodeStatus,
    FLEET_NODE_STICKY_STATUSES,
} from '../entities/fleet-node.entity';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { redactSecrets } from '../utils/secret-scan';
import { FleetNodeRepository } from './fleet-node.repository';
import { normalizeDailyCeilingCents } from './fleet-cost-ceiling.shared';
import {
    CREDENTIAL_MAX_LENGTH,
    CREDENTIAL_MIN_LENGTH,
    constantTimeEquals,
    sha256Hex,
    UUID_RE,
} from './fleet-node-credential';

/**
 * Fleet limits are OPERATOR KNOBS, read through `config.fleet.*` on
 * every use so an env change lands without a restart-shaped code change
 * (and so tests can drive both branches). The constants below are the
 * DEFAULTS those getters fall back to — the same values these used to
 * be hard-coded at — and they stay exported because the node apps and
 * the specs legitimately need the default, not the live setting.
 */

/** Default one-time enrollment-token lifetime (15 minutes). */
export const FLEET_ENROLLMENT_TOKEN_TTL_MS = FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS;

/** Default silence after which an `online` node sweeps to `offline` (5 minutes). */
export const FLEET_NODE_OFFLINE_AFTER_MS = FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS;

/** Kinds a machine can enroll as ('k8s' is list-time only, never a row). */
export const FLEET_ENROLLABLE_KINDS: readonly FleetNodeKind[] = FLEET_ENROLLABLE_NODE_KINDS;

/** Default caps on the node self-description (defensive, DTOs cap the edge too). */
export const FLEET_MAX_CAPABILITY_TAGS = FLEET_DEFAULT_MAX_CAPABILITY_TAGS;
export const FLEET_MAX_CAPABILITY_TAG_LENGTH = FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH;

/**
 * The wire view of one fleet node now lives in `@ever-works/contracts`
 * so the API, the web tier and the node apps compile against ONE
 * declaration. Re-exported here because `@ever-works/agent/fleet` is
 * where every server-side consumer already imports it from.
 */
export type { FleetNodeView };

/**
 * Sentinel `DeployFacadeService.getTokenFromSettings` returns for
 * platform-managed cluster sources. Duplicated here (value-stable, see
 * `PLATFORM_MANAGED_KUBECONFIG_SENTINEL` in `facades/deploy.facade.ts`)
 * so the fleet subpath does not pull the deploy-facade graph; it is a
 * belt-and-braces guard — the `custom-kubeconfig` source check already
 * excludes every platform-managed cluster.
 */
const PLATFORM_MANAGED_KUBECONFIG_SENTINEL = '__ever-works-platform-managed-kubeconfig__';

/**
 * One OUTSTANDING enrollment token — a node row that has been minted but
 * never enrolled.
 *
 * There is no separate token table by design: while a node is
 * `enrolling`, the row IS the token (its `enrollmentTokenHash` holds the
 * token's sha256). Listing the outstanding set is therefore a read of
 * the `enrolling` rows, and revoking one pre-use is a delete of that
 * row. The plaintext token is NOT here and can never be re-read — it was
 * returned exactly once at mint time.
 */
export interface FleetEnrollmentTokenView {
    /** Id of the node the token was minted for (the revoke handle). */
    nodeId: string;
    name: string;
    kind: FleetNodeKind;
    /** When the token was issued (ISO). */
    issuedAt: string | null;
    /** When it stops being consumable (ISO). */
    expiresAt: string | null;
    /** True once `expiresAt` has passed — still revocable, never usable. */
    expired: boolean;
    /**
     * True when the token was minted by a credential ROTATION on an
     * already-enrolled node rather than by a fresh "add node".
     */
    rotated: boolean;
}

export interface CreateEnrollmentTokenInput {
    name: string;
    kind: FleetNodeKind;
    organizationId?: string | null;
}

export interface CreateEnrollmentTokenResult {
    node: FleetNodeView;
    /** Returned exactly once — only its sha256 is stored. */
    token: string;
    expiresInSec: number;
}

export interface EnrollInput {
    platform?: string;
    version?: string;
    capabilities?: string[];
    /**
     * Version of the AGENT CLI on the machine (not the daemon's own).
     *
     * OPTIONAL and BACKWARD-COMPATIBLE by contract: a daemon that
     * predates the field omits it, and `heartbeat` leaves the stored
     * value untouched rather than nulling it. That asymmetry is the
     * whole compatibility story — see the comment in `heartbeat`.
     */
    cliVersion?: string;
    /** Free bytes on the node's workspace volume. Same optional contract. */
    diskFreeBytes?: number;
    /**
     * Which account / seat the agent CLI is logged in as (fleet cost
     * accounting, EW-777) — a display label, never a credential. Same
     * optional contract as {@link cliVersion}.
     */
    modelIdentity?: string;
}

export interface EnrollResult {
    nodeId: string;
    /** Heartbeat secret, returned exactly once — only its sha256 is stored. */
    secret: string;
    node: FleetNodeView;
}

/** Structural shape of the cluster-node summaries the k8s plugin returns. */
interface ClusterNodeSummary {
    name?: string;
    ready?: boolean;
    platform?: string;
    version?: string;
    roles?: string[];
}

/**
 * Fleet (Wave 12, slice 1) — node registry + enrollment + heartbeat.
 *
 * Security posture mirrors `terminal-attach.service.ts` and is shared
 * verbatim with the job-lease protocol through `fleet-node-credential.ts`
 * (ONE definition of "verified" across enroll / heartbeat / lease):
 *   - credentials are random 32-byte values, stored ONLY as sha256 hex;
 *   - verification is constant-time (`timingSafeEqual` behind an
 *     explicit length guard) and NEVER throws — every invalid path
 *     returns null and the API edge maps null to 401 (fail-closed);
 *   - enrollment tokens are single-use (CAS consume) and expire
 *     15 minutes after issue via the row's `createdAt`;
 *   - `lastHeartbeatAt` is server-stamped, never client-trusted.
 *
 * Cluster nodes: `listForUser` best-effort merges live nodes from the
 * user's OWN configured clusters (deployment plugin `clusterSource:
 * 'custom-kubeconfig'` only — platform-operated shared clusters are
 * structurally excluded) tagged `kind: 'k8s'`; they are never
 * persisted, and any plugin/settings failure degrades to the enrolled
 * rows alone.
 */
@Injectable()
export class FleetService {
    private readonly logger = new Logger(FleetService.name);

    constructor(
        private readonly repository: FleetNodeRepository,
        @Optional() private readonly pluginRegistry?: PluginRegistryService,
        @Optional() private readonly pluginSettings?: PluginSettingsService,
    ) {}

    /** Issue a one-time enrollment token for a new node (owner-scoped). */
    async createEnrollmentToken(
        userId: string,
        input: CreateEnrollmentTokenInput,
    ): Promise<CreateEnrollmentTokenResult> {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (name.length < FLEET_MIN_NODE_NAME_LENGTH || name.length > FLEET_MAX_NODE_NAME_LENGTH) {
            throw new BadRequestException(
                `Node name must be ${FLEET_MIN_NODE_NAME_LENGTH}-${FLEET_MAX_NODE_NAME_LENGTH} characters`,
            );
        }
        if (!FLEET_ENROLLABLE_KINDS.includes(input.kind)) {
            throw new BadRequestException(
                `Node kind must be one of: ${FLEET_ENROLLABLE_KINDS.join(', ')}`,
            );
        }

        const token = randomBytes(32).toString('base64url');
        const node = await this.repository.create({
            userId,
            organizationId: input.organizationId ?? null,
            name,
            kind: input.kind,
            status: 'enrolling',
            enrollmentTokenHash: sha256Hex(token),
            credentialIssuedAt: new Date(),
            capabilities: [],
        });

        return {
            node: this.toView(node),
            token,
            expiresInSec: Math.floor(config.fleet.getEnrollmentTokenTtlMs() / 1000),
        };
    }

    /**
     * Consume a one-time enrollment token. Returns null on ANY invalid
     * input (unknown/expired/already-used token) — the caller maps that
     * to a single undifferentiated 401 so nothing leaks about which
     * check failed.
     */
    async enroll(token: unknown, input: EnrollInput = {}): Promise<EnrollResult | null> {
        if (
            typeof token !== 'string' ||
            token.length < CREDENTIAL_MIN_LENGTH ||
            token.length > CREDENTIAL_MAX_LENGTH
        ) {
            return null;
        }

        const tokenHash = sha256Hex(token);
        const node = await this.repository.findByCredentialHash(tokenHash);
        if (!node || node.status !== 'enrolling') {
            return null;
        }
        // Constant-time re-verification of the credential the row was
        // found by — keeps the compare posture uniform with heartbeat
        // (and guards any lookup-layer normalization surprises).
        if (!constantTimeEquals(node.enrollmentTokenHash, tokenHash)) {
            return null;
        }
        // `credentialIssuedAtMs` (not `node.createdAt`): once a
        // credential can be ROTATED, its age must be measured from the
        // rotation, not from when the row was first created — and it
        // also copes with the string dates sqlite hands back. The TTL
        // itself stays the configurable, clamped one.
        const issuedAt = credentialIssuedAtMs(node);
        if (
            !Number.isFinite(issuedAt) ||
            Date.now() - issuedAt > config.fleet.getEnrollmentTokenTtlMs()
        ) {
            return null;
        }

        const secret = randomBytes(32).toString('base64url');
        const now = new Date();
        const patch = {
            enrollmentTokenHash: sha256Hex(secret),
            status: 'online' as FleetNodeStatus,
            lastHeartbeatAt: now,
            platform: sanitizeText(input.platform, FLEET_MAX_PLATFORM_LENGTH),
            version: sanitizeText(input.version, FLEET_MAX_VERSION_LENGTH),
            capabilities: sanitizeCapabilities(input.capabilities),
            // Telemetry is set (possibly to null) on ENROLL because the
            // row is brand new — there is no earlier reading to preserve.
            // Heartbeat is the opposite case and treats absent as
            // "leave alone"; see the comment there.
            cliVersion: sanitizeText(input.cliVersion, FLEET_MAX_CLI_VERSION_LENGTH),
            diskFreeBytes: sanitizeByteCount(input.diskFreeBytes),
            modelIdentity: sanitizeModelIdentity(input.modelIdentity),
        };
        // CAS: single-use by construction — a raced duplicate enroll
        // matches zero rows and gets the same null as a bad token.
        const consumed = await this.repository.consumeEnrollment(node.id, tokenHash, patch);
        if (!consumed) {
            return null;
        }

        return {
            nodeId: node.id,
            secret,
            node: this.toView({ ...node, ...patch }),
        };
    }

    /**
     * Authenticated node heartbeat. Constant-time secret check against
     * the stored hash; fail-closed null on any invalid path (unknown
     * node, still-enrolling node, missing credential, bad secret).
     *
     * A PAUSED or DISABLED node is still accepted (audit A29). Draining
     * a machine must not blind the operator to it: a node that is told
     * to stop taking work and then vanishes from Fleet is
     * indistinguishable from one that crashed, which is precisely the
     * moment its owner most needs to see it. The beat therefore stamps
     * `lastHeartbeatAt` but PRESERVES the sticky status, so a heartbeat
     * can never silently un-pause or re-enable a node.
     */
    async heartbeat(
        nodeId: unknown,
        secret: unknown,
        refresh: EnrollInput = {},
    ): Promise<{ node: FleetNodeView } | null> {
        if (typeof nodeId !== 'string' || !UUID_RE.test(nodeId)) {
            return null;
        }
        if (
            typeof secret !== 'string' ||
            secret.length < CREDENTIAL_MIN_LENGTH ||
            secret.length > CREDENTIAL_MAX_LENGTH
        ) {
            return null;
        }

        const node = await this.repository.findById(nodeId);
        if (!node) return null;
        // An enrolling node has no secret yet (the hash column still
        // holds the token hash), so it can never authenticate here.
        if (node.status === 'enrolling') return null;
        if (!constantTimeEquals(node.enrollmentTokenHash, sha256Hex(secret))) {
            return null;
        }

        const patch: Partial<FleetNode> = {
            status: FLEET_NODE_STICKY_STATUSES.includes(node.status) ? node.status : 'online',
            // Server-stamped — the node never supplies its own clock.
            lastHeartbeatAt: new Date(),
        };
        // A PINNED tag set is the operator's, not the machine's: an
        // admin edit that a heartbeat silently reverted seconds later
        // would not be an edit at all. Unpinning hands the tags back.
        if (refresh.capabilities !== undefined && !node.capabilitiesPinned) {
            patch.capabilities = sanitizeCapabilities(refresh.capabilities);
        }
        const platform = sanitizeText(refresh.platform, FLEET_MAX_PLATFORM_LENGTH);
        if (platform) patch.platform = platform;
        const version = sanitizeText(refresh.version, FLEET_MAX_VERSION_LENGTH);
        if (version) patch.version = version;
        // BACKWARD COMPATIBILITY, stated precisely: a heartbeat that
        // omits a telemetry field leaves the stored value alone. That is
        // what lets an OLDER daemon — one built before `cliVersion` /
        // `diskFreeBytes` existed — keep beating without wiping columns a
        // newer build populated, and it is why these are `if (value)`
        // rather than unconditional assignments. A node that genuinely
        // wants to clear a reading re-enrolls; nothing in the fleet needs
        // "report nothing" to mean "erase".
        const cliVersion = sanitizeText(refresh.cliVersion, FLEET_MAX_CLI_VERSION_LENGTH);
        if (cliVersion) patch.cliVersion = cliVersion;
        const diskFreeBytes = sanitizeByteCount(refresh.diskFreeBytes);
        if (diskFreeBytes !== null) patch.diskFreeBytes = diskFreeBytes;
        // Same additive contract (EW-777): a beat that says nothing about
        // the seat leaves the last reported seat in place.
        const modelIdentity = sanitizeModelIdentity(refresh.modelIdentity);
        if (modelIdentity) patch.modelIdentity = modelIdentity;

        await this.repository.update(node.id, patch);
        return { node: this.toView({ ...node, ...patch }) };
    }

    /**
     * Fleet cost accounting (EW-777) — set (or clear, with null) one node's
     * DAILY model-spend ceiling, owner-scoped. Validated the way the
     * fleet-wide one is: a positive whole number of cents up to the
     * contract cap, refused rather than clamped. Clearing it hands the node
     * back to the deployment default (`FLEET_NODE_DAILY_COST_CEILING_USD`).
     *
     * Changing the ceiling RE-ARMS the one-notice marker
     * (`dailyCostTrippedOn`). The marker exists so that the tenth
     * completion crossing the same ceiling on the same day says nothing
     * new — but an owner who raised the ceiling after a trip has made a
     * new decision, and the NEXT crossing (of the new ceiling) is news
     * again. Left set, that crossing would drain the node in silence.
     */
    async setDailyCostCeilingForUser(
        userId: string,
        nodeId: string,
        dailyCostCeilingCents: unknown,
    ): Promise<FleetNodeView> {
        const ceiling = normalizeDailyCeilingCents(dailyCostCeilingCents);
        const node = await this.getOwnedNode(userId, nodeId);
        const patch: Partial<FleetNode> = {
            dailyCostCeilingCents: ceiling,
            dailyCostTrippedOn: null,
        };
        await this.repository.update(node.id, patch);
        return this.toView({ ...node, ...patch } as FleetNode);
    }

    /**
     * Owner-scoped node list: sweeps stale `online` rows to `offline`
     * (5-minute heartbeat window — piggybacked here, no cron), then
     * merges live nodes from the user's own configured clusters
     * (best-effort, `kind: 'k8s'`, never persisted).
     */
    async listForUser(userId: string): Promise<FleetNodeView[]> {
        const rows = await this.listEnrolledForUser(userId);
        const clusterNodes = await this.listOwnClusterNodes(userId);
        return [...rows, ...clusterNodes];
    }

    /**
     * The owner's ENROLLED rows only — same offline sweep as
     * {@link listForUser}, without the live cluster merge.
     *
     * Split out because the cluster merge talks to the user's Kubernetes
     * API through the deployment plugin, and two callers must never pay
     * for that: the runner-status pill (polled every 30s from every
     * dashboard page) and the run router (on the dispatch hot path). It
     * would also be actively wrong for them — a cluster node is not a
     * runner the platform can lease work onto, so counting one would
     * have the pill claim capacity that cannot execute anything and the
     * router route work to a machine that will never poll for it.
     */
    async listEnrolledForUser(userId: string): Promise<FleetNodeView[]> {
        await this.repository.sweepOffline(
            userId,
            new Date(Date.now() - config.fleet.getNodeOfflineAfterMs()),
        );
        const rows = await this.repository.findByUser(userId);
        return rows.map((row) => this.toView(row));
    }

    /**
     * One enrolled node (owner-scoped, no existence leak). Backs the
     * node-detail drawer; the failure history shown alongside it is
     * composed at the API edge from `FleetJobService`, so the registry
     * stays independent of the job runtime.
     */
    async getForUser(userId: string, nodeId: string): Promise<FleetNodeView> {
        return this.toView(await this.getOwnedNode(userId, nodeId));
    }

    /**
     * Every OUTSTANDING enrollment token of this owner — i.e. every node
     * still sitting in `enrolling`, whether the token is fresh, about to
     * expire, or already expired.
     *
     * Expired entries are deliberately still listed: "there is a stale
     * credential row for a machine I never finished setting up" is
     * exactly the thing an operator wants to see and clean up, and
     * hiding it would make the registry quietly disagree with the node
     * list. Nothing here can reconstruct the plaintext token.
     */
    async listOutstandingTokensForUser(userId: string): Promise<FleetEnrollmentTokenView[]> {
        const rows = await this.repository.findByUser(userId);
        const now = Date.now();
        return rows
            .filter((row) => row.status === 'enrolling')
            .map((row) => {
                const issuedAtMs = credentialIssuedAtMs(row);
                const hasIssuedAt = Number.isFinite(issuedAtMs);
                const expiresAtMs = issuedAtMs + FLEET_ENROLLMENT_TOKEN_TTL_MS;
                return {
                    nodeId: row.id,
                    name: row.name,
                    kind: row.kind,
                    issuedAt: hasIssuedAt ? new Date(issuedAtMs).toISOString() : null,
                    expiresAt: hasIssuedAt ? new Date(expiresAtMs).toISOString() : null,
                    // A row we cannot date is treated as expired — the
                    // enroll path refuses it for the same reason.
                    expired: !hasIssuedAt || expiresAtMs <= now,
                    // A rotation mints a token on a row that already
                    // beat once; a fresh "add node" never has.
                    rotated: Boolean(row.lastHeartbeatAt),
                };
            });
    }

    /**
     * Revoke an outstanding enrollment token BEFORE it is used.
     *
     * Only `enrolling` rows qualify: once a token has been consumed the
     * row's hash is a heartbeat secret, and destroying that silently
     * would be a node deletion wearing a token-revocation label. For an
     * enrolled node the operator wants {@link rotateCredentialForUser}
     * (mint a replacement) or `deleteForUser` (remove the machine) —
     * both explicit, both already surfaced.
     *
     * Revoking a never-enrolled row deletes it, because the row exists
     * only to carry the token: there is no machine behind it yet.
     */
    async revokeEnrollmentTokenForUser(userId: string, nodeId: string): Promise<void> {
        const node = await this.getOwnedNode(userId, nodeId);
        if (node.status !== 'enrolling') {
            throw new BadRequestException(
                'Only an unused enrollment token can be revoked; rotate the node credential instead',
            );
        }
        await this.repository.delete(node.id);
    }

    /**
     * Rotate a node's credential: mint a fresh one-time enrollment token
     * and put the node back to `enrolling`.
     *
     * The old heartbeat secret dies the instant the hash is replaced —
     * that is the entire point, and it is why rotation is a drain as
     * well as a re-key: the machine stops being able to report or lease
     * until it re-enrolls with the new token. Returned exactly once,
     * like every other Fleet credential.
     */
    async rotateCredentialForUser(
        userId: string,
        nodeId: string,
    ): Promise<CreateEnrollmentTokenResult> {
        const node = await this.getOwnedNode(userId, nodeId);
        const token = randomBytes(32).toString('base64url');
        const patch: Partial<FleetNode> = {
            enrollmentTokenHash: sha256Hex(token),
            credentialIssuedAt: new Date(),
            status: 'enrolling',
        };
        await this.repository.update(node.id, patch);
        return {
            node: this.toView({ ...node, ...patch } as FleetNode),
            token,
            expiresInSec: Math.floor(FLEET_ENROLLMENT_TOKEN_TTL_MS / 1000),
        };
    }

    /**
     * Hand-edit a node's capability tags (owner-scoped).
     *
     * Writing tags PINS them, so the node's next heartbeat no longer
     * overwrites the operator's set. Passing `pinned: false` clears the
     * pin and hands ownership of the tags back to the machine — the tags
     * written in the same call still land, they simply stop being
     * authoritative from the next beat onwards.
     */
    async setCapabilitiesForUser(
        userId: string,
        nodeId: string,
        capabilities: unknown,
        pinned = true,
    ): Promise<FleetNodeView> {
        if (!Array.isArray(capabilities)) {
            throw new BadRequestException('Capabilities must be an array of tags');
        }
        const node = await this.getOwnedNode(userId, nodeId);
        const patch: Partial<FleetNode> = {
            capabilities: sanitizeCapabilities(capabilities),
            capabilitiesPinned: pinned,
        };
        await this.repository.update(node.id, patch);
        return this.toView({ ...node, ...patch } as FleetNode);
    }

    /** Rename an enrolled node (owner-scoped, no existence leak). */
    async renameForUser(userId: string, nodeId: string, name: string): Promise<FleetNodeView> {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (
            trimmed.length < FLEET_MIN_NODE_NAME_LENGTH ||
            trimmed.length > FLEET_MAX_NODE_NAME_LENGTH
        ) {
            throw new BadRequestException(
                `Node name must be ${FLEET_MIN_NODE_NAME_LENGTH}-${FLEET_MAX_NODE_NAME_LENGTH} characters`,
            );
        }
        const node = await this.getOwnedNode(userId, nodeId);
        await this.repository.update(node.id, { name: trimmed });
        return this.toView({ ...node, name: trimmed });
    }

    /**
     * Disable or re-enable a node. Disabling an `enrolling` node
     * revokes its unused token (the enroll CAS requires status
     * `enrolling`); re-enabling lands on `offline` until the next
     * accepted heartbeat proves the node alive.
     *
     * Disabling DRAINS rather than severs: no further work is leased
     * onto the node, but the jobs it already holds keep their claims
     * and still report their verdicts, and the node keeps heartbeating
     * so it remains observable (see `heartbeat` and
     * `FleetJobService.authenticateNode`).
     */
    async setDisabledForUser(
        userId: string,
        nodeId: string,
        disabled: boolean,
    ): Promise<FleetNodeView> {
        const node = await this.getOwnedNode(userId, nodeId);
        const status: FleetNodeStatus = disabled ? 'disabled' : 'offline';
        await this.repository.update(node.id, { status });
        return this.toView({ ...node, status });
    }

    /**
     * Pause (drain) or resume a node, owner-scoped.
     *
     * Distinct from `setDisabledForUser`: pausing is the SOFT stop an
     * operator reaches for when a machine is needed for something else
     * for an hour. New work stops being leased onto it immediately, its
     * in-flight claims keep running and keep reporting, and it keeps
     * heartbeating so it stays visible. Resuming lands on `offline`
     * until the next accepted heartbeat proves the node alive — the
     * same convention `setDisabledForUser` uses.
     */
    async setPausedForUser(
        userId: string,
        nodeId: string,
        paused: boolean,
    ): Promise<FleetNodeView> {
        const node = await this.getOwnedNode(userId, nodeId);
        // Never let "resume" silently undo a disable: a disabled node
        // has to be re-enabled explicitly.
        if (!paused && node.status === 'disabled') {
            return this.toView(node);
        }
        const status: FleetNodeStatus = paused ? 'paused' : 'offline';
        await this.repository.update(node.id, { status });
        return this.toView({ ...node, status });
    }

    /**
     * Node-initiated pause/resume — `ever-works-node pause` on the
     * machine itself. Authenticated with the node's OWN heartbeat
     * secret (the same constant-time hash check every node-facing
     * endpoint uses), so an operator sitting at the keyboard can drain
     * their machine without a platform session.
     *
     * Returns null on every invalid path so the edge answers one
     * undifferentiated 401. A still-enrolling node cannot pause: its
     * hash column holds a token, not a secret.
     */
    async setPausedByCredential(
        nodeId: unknown,
        secret: unknown,
        paused: boolean,
    ): Promise<{ node: FleetNodeView } | null> {
        const node = await this.authenticateNodeByCredential(nodeId, secret);
        if (!node) return null;
        // A node may drain ITSELF, but must not be able to lift an
        // owner-imposed disable by asking nicely.
        if (!paused && node.status === 'disabled') {
            return { node: this.toView(node) };
        }
        const status: FleetNodeStatus = paused ? 'paused' : 'offline';
        await this.repository.update(node.id, { status });
        return { node: this.toView({ ...node, status }) };
    }

    /**
     * Node-initiated unenrollment — `ever-works-node unenroll`. Deletes
     * the registration the presented credential belongs to, which is
     * what makes the credential itself worthless from that moment on.
     *
     * Deliberately a DELETE rather than a status flip: the machine is
     * telling the platform it is leaving, and leaving a dangling row
     * whose secret still lives on a decommissioned laptop is the worse
     * outcome. Returns false on every invalid path (one 401 at the edge).
     */
    async unenrollByCredential(nodeId: unknown, secret: unknown): Promise<boolean> {
        const node = await this.authenticateNodeByCredential(nodeId, secret);
        if (!node) return false;
        await this.repository.delete(node.id);
        return true;
    }

    /** Delete a node registration (owner-scoped, no existence leak). */
    async deleteForUser(userId: string, nodeId: string): Promise<void> {
        const node = await this.getOwnedNode(userId, nodeId);
        await this.repository.delete(node.id);
    }

    /**
     * Resolve + verify a node by its own heartbeat credential. Shares
     * the heartbeat posture exactly: shape guards before any read,
     * constant-time hash compare, null on every failure.
     */
    private async authenticateNodeByCredential(
        nodeId: unknown,
        secret: unknown,
    ): Promise<FleetNode | null> {
        if (typeof nodeId !== 'string' || !UUID_RE.test(nodeId)) return null;
        if (
            typeof secret !== 'string' ||
            secret.length < CREDENTIAL_MIN_LENGTH ||
            secret.length > CREDENTIAL_MAX_LENGTH
        ) {
            return null;
        }
        const node = await this.repository.findById(nodeId);
        if (!node) return null;
        if (node.status === 'enrolling') return null;
        if (!constantTimeEquals(node.enrollmentTokenHash, sha256Hex(secret))) return null;
        return node;
    }

    private async getOwnedNode(userId: string, nodeId: string): Promise<FleetNode> {
        const node = await this.repository.findById(nodeId);
        // Other users' nodes are indistinguishable from missing ones.
        if (!node || node.userId !== userId) {
            throw new NotFoundException(`Fleet node ${nodeId} not found`);
        }
        return node;
    }

    /**
     * Live nodes of the user's OWN configured clusters, via the
     * deployment plugin. Strictly best-effort: any missing plugin,
     * settings failure or cluster error returns []. Platform-managed
     * cluster sources are excluded by the `custom-kubeconfig` check
     * (and the sentinel guard) — the shared platform clusters can never
     * appear in Fleet.
     */
    private async listOwnClusterNodes(userId: string): Promise<FleetNodeView[]> {
        if (!this.pluginRegistry || !this.pluginSettings) return [];
        try {
            const registered = this.pluginRegistry.get('k8s');
            if (!registered) return [];

            const settings = await this.pluginSettings.getResolvedSettings('k8s', {
                userId,
                includeSecrets: true,
            });
            const clusterSource = settings.clusterSource?.value as string | undefined;
            if (clusterSource !== 'custom-kubeconfig') return [];
            const kubeconfig = settings.kubeconfig?.value as string | undefined;
            if (!kubeconfig || kubeconfig === PLATFORM_MANAGED_KUBECONFIG_SENTINEL) return [];
            const kubeContext = settings.kubeContext?.value as string | undefined;

            const plugin = await this.materialize(registered.plugin);
            const listClusterNodes = (
                plugin as unknown as {
                    listClusterNodes?: (
                        kubeconfigYaml: string,
                        contextOverride?: string,
                    ) => Promise<ClusterNodeSummary[]>;
                }
            ).listClusterNodes;
            if (typeof listClusterNodes !== 'function') return [];

            const nodes = await listClusterNodes.call(plugin, kubeconfig, kubeContext);
            if (!Array.isArray(nodes)) return [];
            return nodes.map((node) => this.clusterNodeToView(node));
        } catch (error) {
            this.logger.debug(
                `Cluster node listing degraded to enrolled rows only: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return [];
        }
    }

    /** Under lazy plugin loading the registry hands out a proxy stub. */
    private async materialize(plugin: IPlugin): Promise<IPlugin> {
        const stub = plugin as unknown as { __materialize?: () => Promise<IPlugin> };
        if (typeof stub.__materialize === 'function') {
            return stub.__materialize();
        }
        return plugin;
    }

    private clusterNodeToView(node: ClusterNodeSummary): FleetNodeView {
        const name = typeof node.name === 'string' && node.name ? node.name : 'unknown';
        return {
            id: `k8s:${name}`,
            name,
            kind: 'k8s',
            status: node.ready ? 'online' : 'offline',
            platform: sanitizeText(node.platform, FLEET_MAX_PLATFORM_LENGTH),
            version: sanitizeText(node.version, FLEET_MAX_VERSION_LENGTH),
            capabilities: sanitizeCapabilities(node.roles),
            lastHeartbeatAt: null,
            createdAt: null,
            persisted: false,
            // Cluster roles are read live from the cluster on every list;
            // there is no row to pin them onto.
            capabilitiesPinned: false,
        };
    }

    /** Entity → wire view. Credential hashes never leave the service. */
    private toView(node: FleetNode): FleetNodeView {
        return {
            id: node.id,
            name: node.name,
            kind: node.kind,
            status: node.status,
            platform: node.platform ?? null,
            version: node.version ?? null,
            capabilities: node.capabilities ?? [],
            lastHeartbeatAt: node.lastHeartbeatAt ? toIso(node.lastHeartbeatAt) : null,
            createdAt: node.createdAt ? toIso(node.createdAt) : null,
            persisted: true,
            capabilitiesPinned: Boolean(node.capabilitiesPinned),
            cliVersion: node.cliVersion ?? null,
            // `bigint` comes back as a STRING on Postgres and a number on
            // sqlite. Normalizing HERE — the one place an entity becomes
            // a wire view — is what stops `"12345" > 0` style bugs from
            // reaching the UI on one driver and not the other.
            diskFreeBytes: toOptionalNumber(node.diskFreeBytes),
            // Fleet cost accounting (EW-777).
            modelIdentity: node.modelIdentity ?? null,
            dailyCostCeilingCents: toOptionalNumber(node.dailyCostCeilingCents),
            dailyCostTrippedOn: node.dailyCostTrippedOn ?? null,
        };
    }
}

/**
 * Coerce a `bigint` column value (string on Postgres, number on sqlite,
 * null when unset) into a plain number or null. Values that are not
 * finite non-negative numbers collapse to null rather than propagating a
 * NaN into a JSON response.
 */
function toOptionalNumber(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return parsed;
}

/**
 * When the row's CURRENT credential was issued, in epoch ms.
 *
 * Falls back to `createdAt` for rows written before rotation existed —
 * for those the two are the same instant by construction. `NaN` when
 * neither is a usable date, which every caller treats as "expired".
 */
function credentialIssuedAtMs(node: FleetNode): number {
    const issued = node.credentialIssuedAt ?? node.createdAt;
    if (issued instanceof Date) return issued.getTime();
    if (typeof issued === 'string') return new Date(issued).getTime();
    return NaN;
}

/**
 * Accept a node-reported byte count, or refuse it.
 *
 * Refuses (returns null) rather than clamps: a machine reporting a
 * negative, non-integral or absurd free-space figure has a broken probe
 * — or is lying — and clamping would turn that into a plausible-looking
 * number the operator would then act on. `null` renders as "unknown",
 * which is the honest answer.
 */
function sanitizeByteCount(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (value < 0 || value > FLEET_MAX_DISK_FREE_BYTES) return null;
    return Math.floor(value);
}

function sanitizeText(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLength);
}

/**
 * Fleet cost accounting (EW-777) — the billing identity a node reports.
 *
 * The daemon builds the label from whitelisted fields of the CLI's own
 * status output, so a credential can only arrive here from a tampered or
 * misbuilt daemon — and this field is stored, listed, frozen into every
 * run's usage metadata and quoted in Inbox notices, so it is scrubbed for
 * known token shapes anyway. Defence in depth: the wire is untrusted.
 */
function sanitizeModelIdentity(value: unknown): string | null {
    const text = sanitizeText(value, FLEET_MAX_MODEL_IDENTITY_LENGTH);
    if (!text) return null;
    // The placeholder can be longer than the token it replaces — re-cap.
    return redactSecrets(text).cleaned.slice(0, FLEET_MAX_MODEL_IDENTITY_LENGTH);
}

/**
 * Truncate + dedupe capability tags to the CONFIGURED caps. Read per
 * call rather than captured at module load so an operator override is
 * honoured by the running process and both branches are testable.
 */
function sanitizeCapabilities(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const maxTags = config.fleet.getMaxCapabilityTags();
    const maxTagLength = config.fleet.getMaxCapabilityTagLength();
    const out: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') continue;
        const tag = entry.trim().slice(0, maxTagLength);
        if (!tag || out.includes(tag)) continue;
        out.push(tag);
        if (out.length >= maxTags) break;
    }
    return out;
}

function toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
