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
    FLEET_MAX_NODE_NAME_LENGTH,
    FLEET_MAX_PLATFORM_LENGTH,
    FLEET_MAX_VERSION_LENGTH,
    FLEET_MIN_NODE_NAME_LENGTH,
} from '@ever-works/contracts';
import type { FleetNodeView } from '@ever-works/contracts';
import { config } from '../config';
import { FleetNode, FleetNodeKind, FleetNodeStatus } from '../entities/fleet-node.entity';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { FleetNodeRepository } from './fleet-node.repository';
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
        const issuedAt = node.createdAt instanceof Date ? node.createdAt.getTime() : NaN;
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
     * node, disabled node, missing credential, bad secret).
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
        // A disabled node must stop reporting; an enrolling node has no
        // secret yet (the hash column still holds the token hash).
        if (node.status === 'disabled' || node.status === 'enrolling') return null;
        if (!constantTimeEquals(node.enrollmentTokenHash, sha256Hex(secret))) {
            return null;
        }

        const patch: Partial<FleetNode> = {
            status: 'online',
            // Server-stamped — the node never supplies its own clock.
            lastHeartbeatAt: new Date(),
        };
        if (refresh.capabilities !== undefined) {
            patch.capabilities = sanitizeCapabilities(refresh.capabilities);
        }
        const platform = sanitizeText(refresh.platform, FLEET_MAX_PLATFORM_LENGTH);
        if (platform) patch.platform = platform;
        const version = sanitizeText(refresh.version, FLEET_MAX_VERSION_LENGTH);
        if (version) patch.version = version;

        await this.repository.update(node.id, patch);
        return { node: this.toView({ ...node, ...patch }) };
    }

    /**
     * Owner-scoped node list: sweeps stale `online` rows to `offline`
     * (5-minute heartbeat window — piggybacked here, no cron), then
     * merges live nodes from the user's own configured clusters
     * (best-effort, `kind: 'k8s'`, never persisted).
     */
    async listForUser(userId: string): Promise<FleetNodeView[]> {
        await this.repository.sweepOffline(
            userId,
            new Date(Date.now() - config.fleet.getNodeOfflineAfterMs()),
        );
        const rows = await this.repository.findByUser(userId);
        const clusterNodes = await this.listOwnClusterNodes(userId);
        return [...rows.map((row) => this.toView(row)), ...clusterNodes];
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
     * Disable (drain) or re-enable a node. Disabling an `enrolling`
     * node revokes its unused token (the enroll CAS requires status
     * `enrolling`); re-enabling lands on `offline` until the next
     * accepted heartbeat proves the node alive.
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

    /** Delete a node registration (owner-scoped, no existence leak). */
    async deleteForUser(userId: string, nodeId: string): Promise<void> {
        const node = await this.getOwnedNode(userId, nodeId);
        await this.repository.delete(node.id);
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
        };
    }
}

function sanitizeText(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLength);
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
