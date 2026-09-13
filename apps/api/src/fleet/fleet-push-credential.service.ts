import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    FLEET_PUSH_CREDENTIAL_MAX_REPOSITORIES,
    FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON,
    FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON,
    FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON,
    FLEET_PUSH_CREDENTIAL_USERNAME,
    fleetPushRemoteRepositoryId,
    normalizeFleetPushRepositoryId,
    sanitizeFleetPushIdentityText,
    type FleetJobPushCredentialResponse,
    type FleetPushAttribution,
} from '@ever-works/contracts';
import { FleetJobRepository, FleetNodeRepository, FleetJobService } from '@ever-works/agent/fleet';
import {
    AgentRepository,
    GitHubAppInstallationRepoRepository,
    GitHubAppInstallationRepository,
} from '@ever-works/agent/database';
import { config } from '@ever-works/agent/config';
import { requestGitHubAppInstallationAccessTokenDetails } from '@ever-works/agent/utils';

/**
 * A refusal the node can act on. Carries a STABLE machine token as its
 * message and nothing else — no installation id, no repository name, no
 * GitHub response body.
 */
export class FleetPushCredentialError extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'FleetPushCredentialError';
    }
}

/**
 * What the scope resolver decided, before anything is minted.
 *
 * `reason` is present on BOTH arms (null when it resolved) rather than
 * only on the refusal: `apps/api` compiles with `strictNullChecks: false`,
 * where narrowing a discriminated union in the NEGATIVE branch does not
 * reliably reach the refusal arm's own fields. A reader should not have to
 * know that, so the shape simply does not depend on it.
 */
export type FleetPushScope =
    | {
          readonly ok: true;
          readonly reason: null;
          /** Installation ENTITY row id. */
          readonly installationEntityId: string;
          /** GitHub's own numeric installation id (what the mint URL uses). */
          readonly installationId: string;
          /** GitHub's numeric repository ids, from the platform's snapshot. */
          readonly repositoryIds: string[];
          /** The same repositories as normalized `owner/repo`, for the node. */
          readonly repositories: string[];
      }
    | { readonly ok: false; readonly reason: string };

/**
 * One repository the mint must cover, as it appears in a job's workspace.
 *
 * The CLONE URL is carried alongside the name, and where it is present it
 * is the authority. `repositoryId` is only ever `owner/repo`, and
 * `owner/repo` is not an identity without a host in front of it: a `git`
 * repo connection's url is a bare `@IsString()` with no host constraint
 * (`repo-connection.dto.ts`), and `repositoryIdFromCloneUrl` is
 * host-agnostic, so a mount at `https://gitlab.example/acme/widgets`
 * yields `acme/widgets` — which would then match a GITHUB installation
 * row of the same name and mint a `contents: write` token for
 * `github.com/acme/widgets`, a repository this job has nothing to do
 * with. Slice AM's review found that (F4); this type is what stops the
 * platform issuing it in the first place, and the node's own host check
 * is the second half.
 */
export interface FleetPushRepositoryRequest {
    readonly repositoryId: string;
    /** The token-free clone URL, when the caller has it. */
    readonly repoUrl?: string | null;
}

/**
 * Scoped push credentials (self-build slice AM, EW-810) — the platform
 * half of `POST /api/fleet/jobs/:id/push-credential`.
 *
 * ## What this service is for
 *
 * A fleet node's `git push` used to be authenticated by the machine's own
 * Git credential helper: a long-lived personal access token, in the OS
 * credential store, with write access to every repository that OS user
 * can reach. The platform could not scope it, rotate it, revoke it or
 * observe it. This service replaces it with a GitHub App INSTALLATION
 * token, minted per job, narrowed to the repository ids the job actually
 * writes to and to `contents: write` alone.
 *
 * ## The rules this file exists to keep
 *
 * - **The scope comes from PLATFORM STATE.** The repositories are read
 *   from the job's own `payload.workspace` — which the PLANNER wrote, so
 *   this is the platform re-reading its own decision, the same posture
 *   `FleetRunCredentialService.bridgeRequested` takes — and then resolved
 *   against `github_app_installation_repositories`, the snapshot
 *   `GitHubAppSyncService` keeps from GitHub. The numeric repository ids
 *   the token is narrowed by come from THAT table, never from a name a
 *   node or a payload supplied.
 * - **The installation must belong to the job's owner.** `findByFullName`
 *   is global — it returns rows for every installation in the deployment —
 *   so an ownership filter is the only thing between a job and a token for
 *   somebody else's repository.
 * - **Fail closed, with a stable reason.** No App configured, no
 *   installation covering every repository, two installations, a suspended
 *   or deleted installation, a GitHub refusal: each is a refusal the node
 *   turns into a failed run that NAMES the gap. There is no fallback to
 *   the node's ambient helper — that fallback is the hole this closes.
 * - **Nothing about the token is logged, stored or echoed.** The log line
 *   names the job, the node and the repositories. The token exists in this
 *   process for the length of one response and is never written anywhere.
 */
@Injectable()
export class FleetPushCredentialService {
    private readonly logger = new Logger(FleetPushCredentialService.name);

    constructor(
        private readonly jobs: FleetJobService,
        private readonly jobRows: FleetJobRepository,
        private readonly nodes: FleetNodeRepository,
        private readonly installations: GitHubAppInstallationRepository,
        private readonly installationRepos: GitHubAppInstallationRepoRepository,
        // Appended LAST and @Optional(): attribution degrades to "the job
        // named an Agent we could not name" rather than refusing the mint,
        // and a reduced module graph still constructs.
        @Optional() private readonly agents?: AgentRepository,
    ) {}

    /**
     * Authorize the caller, then answer with this run's attribution and —
     * when the job's own plan pushes — a scoped write credential.
     *
     * Returns `null` when the node credential / holder / status proof
     * fails, so the controller answers the SAME undifferentiated 401 every
     * other route on this channel answers. A stale lease propagates as
     * `FleetJobStaleLeaseError` (409). Everything else throws
     * {@link FleetPushCredentialError}, which the controller renders as a
     * 422 carrying only the stable token.
     */
    async mint(input: {
        nodeId: unknown;
        secret: unknown;
        jobId: string;
        leaseGeneration?: unknown;
    }): Promise<FleetJobPushCredentialResponse | null> {
        // The SAME four checks `env-files` runs, and for the same reason:
        // handing a machine a write credential for the owner's
        // repositories is at least as consequential as handing it their
        // decrypted `.env`. Reused rather than re-implemented so the two
        // sensitive deliveries on this channel cannot drift apart.
        const claim = await this.jobs.authorizeRunSecretRequest({
            nodeId: input.nodeId,
            secret: input.secret,
            jobId: input.jobId,
            leaseGeneration: input.leaseGeneration,
        });
        if (!claim) return null;

        const job = await this.jobRows.findById(claim.jobId);
        // The row was there a moment ago (the authorizer read it), so its
        // absence now is a race with deletion, not a caller error.
        if (!job) return null;

        const attribution = await this.describeAttribution(claim, job);

        // The platform re-reads its OWN plan. A node cannot ask for a write
        // credential on a job whose plan only commits, and cannot decline
        // one on a job whose plan pushes.
        if (!this.jobPushes(job)) {
            this.logger.log(
                `Fleet job ${claim.jobId}: attribution issued to node ${claim.nodeId} (plan does not push, no credential minted)`,
            );
            return { attribution, push: null };
        }

        const scope = await this.resolveScope(claim.userId, this.repositoriesOf(job));
        if (!scope.ok) throw this.refusal(claim.jobId, scope.reason);

        const credentials = this.appCredentials();
        if (!credentials)
            throw this.refusal(claim.jobId, FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON);

        let minted: { token: string; expiresAt: string | null };
        try {
            minted = await requestGitHubAppInstallationAccessTokenDetails(
                scope.installationId,
                credentials,
                {
                    repositoryIds: scope.repositoryIds,
                    // The ONE permission a push needs. Anything omitted is
                    // not granted, so this token cannot open a pull request,
                    // read a secret, or touch an Action — even though the
                    // App itself may hold those permissions.
                    permissions: { contents: 'write' },
                },
            );
        } catch (error) {
            // The GitHub message can name the installation and the App;
            // it never reaches the node, and never the job row.
            this.logger.error(
                `Fleet job ${claim.jobId}: scoped push token mint failed (${
                    error instanceof Error ? error.name : 'unknown error'
                })`,
            );
            throw this.refusal(claim.jobId, FLEET_PUSH_CREDENTIAL_MINT_FAILED_REASON);
        }

        // This line is the audit record. It names the job, the node and the
        // repositories the credential covers. The TOKEN is not in it and
        // must never be.
        this.logger.log(
            `Fleet job ${claim.jobId}: scoped push credential minted for node ${claim.nodeId} ` +
                `covering ${scope.repositories.join(', ')} (expires ${minted.expiresAt ?? 'in ~1h'})`,
        );

        return {
            attribution,
            push: {
                token: minted.token,
                username: FLEET_PUSH_CREDENTIAL_USERNAME,
                // GitHub always expires an installation token within the
                // hour; the fallback exists so the node always has an
                // instant to compare against rather than a null.
                expiresAt: minted.expiresAt ?? new Date(Date.now() + 55 * 60_000).toISOString(),
                repositories: scope.repositories,
            },
        };
    }

    /**
     * Can the platform mint a write credential for these repositories,
     * WITHOUT minting one?
     *
     * This is the pre-dispatch half of the slice: the planner asks before
     * a job exists, so a Task whose repository no installation covers is
     * refused at plan time — with the reason on the run row — instead of
     * consuming twenty minutes of model time and then failing at the push.
     * Pure platform state; no GitHub call.
     */
    async describeScope(
        userId: string,
        repositories: readonly FleetPushRepositoryRequest[],
    ): Promise<FleetPushScope> {
        if (!this.appCredentials()) {
            return { ok: false, reason: FLEET_PUSH_CREDENTIAL_NOT_CONFIGURED_REASON };
        }
        return this.resolveScope(userId, repositories);
    }

    /**
     * Which installation covers EVERY repository this job writes to.
     *
     * One installation or none: a token is minted against a single
     * installation, so a run spanning two of them cannot be served by one
     * credential and is refused rather than half-served. The refusal is
     * the same stable token in every case — a differentiated answer here
     * would let a caller enumerate which repositories the deployment has
     * installations for.
     */
    private async resolveScope(
        userId: string,
        requested: readonly FleetPushRepositoryRequest[],
    ): Promise<FleetPushScope> {
        const wanted: string[] = [];
        for (const entry of requested) {
            const normalized = this.pushTargetOf(entry);
            if (!normalized) return { ok: false, reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON };
            if (!wanted.includes(normalized)) wanted.push(normalized);
        }
        if (wanted.length === 0 || wanted.length > FLEET_PUSH_CREDENTIAL_MAX_REPOSITORIES) {
            return { ok: false, reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON };
        }

        // installationEntityId -> the snapshot rows that installation has
        // for the repositories we want.
        const byInstallation = new Map<string, Map<string, string>>();
        for (const fullName of wanted) {
            let rows: Awaited<ReturnType<GitHubAppInstallationRepoRepository['findByFullName']>>;
            try {
                rows = await this.installationRepos.findByFullName(fullName);
            } catch {
                return { ok: false, reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON };
            }
            for (const row of rows) {
                // `findByFullName` matches case-INSENSITIVELY — `fullName` is
                // stored verbatim from GitHub's `full_name`, so an exact
                // comparison could never find `Ever-Works/Directory-Web-Template`
                // from the lower-cased name this resolver asks with, and every
                // repository carrying an upper-case character silently lost
                // fleet execution. It is still global across the deployment, so
                // the ownership filter below is what keeps a job away from
                // somebody else's installation, and the normalized re-check
                // here is what keeps a looser match from widening the scope.
                if (normalizeFleetPushRepositoryId(row.fullName) !== fullName) continue;
                if (!(await this.ownsInstallation(userId, row.installationEntityId))) continue;
                const bucket =
                    byInstallation.get(row.installationEntityId) ?? new Map<string, string>();
                bucket.set(fullName, row.githubRepoId);
                byInstallation.set(row.installationEntityId, bucket);
            }
        }

        const complete = [...byInstallation.entries()].filter(
            ([, repos]) => repos.size === wanted.length,
        );
        // Exactly one, or refuse. Zero means nothing covers the whole run.
        // More than one means the owner installed the App twice over the
        // same repositories, and picking by listing order would decide
        // which installation's audit trail records the write by luck.
        if (complete.length !== 1) {
            return { ok: false, reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON };
        }
        const [installationEntityId, repos] = complete[0];
        const installation = await this.loadInstallation(installationEntityId);
        if (!installation) return { ok: false, reason: FLEET_PUSH_CREDENTIAL_UNRESOLVED_REASON };

        return {
            ok: true,
            reason: null,
            installationEntityId,
            installationId: installation.installationId,
            repositoryIds: wanted.map((fullName) => repos.get(fullName) as string),
            repositories: wanted,
        };
    }

    /**
     * The `owner/repo` a mint may cover for this workspace entry, or null.
     *
     * FAILS CLOSED on any disagreement. When the entry carries a clone URL
     * the URL decides, because it is the thing the node will actually push
     * to, and {@link fleetPushRemoteRepositoryId} refuses anything that is
     * not an `https://github.com/owner/repo` — an installation token is a
     * GitHub credential and means nothing anywhere else. A `repositoryId`
     * that disagrees with its own URL is refused rather than reconciled:
     * the two come from the same planner in the same breath, so a
     * disagreement is a bug, and picking either one would be picking which
     * repository gets a write token by luck.
     *
     * Without a URL this falls back to the name alone, which is what the
     * pre-slice payloads carry. That is still safe: the NODE re-derives the
     * repository from the checkout's actual `origin` and refuses the push
     * if the host is not github.com, so a name-only scope can waste a mint
     * but can never aim a credential.
     */
    private pushTargetOf(entry: FleetPushRepositoryRequest): string | null {
        const named = normalizeFleetPushRepositoryId(entry?.repositoryId);
        const repoUrl = typeof entry?.repoUrl === 'string' ? entry.repoUrl.trim() : '';
        if (!repoUrl) return named;
        const fromUrl = fleetPushRemoteRepositoryId(repoUrl);
        if (!fromUrl) return null;
        if (named && named !== fromUrl) return null;
        return fromUrl;
    }

    /**
     * Is this installation the job owner's?
     *
     * Deleted and suspended installations are refused here as well as at
     * mint time: GitHub honours a suspension, but a suspended installation
     * that still answers would mean the platform believed it could write
     * repositories the owner has revoked.
     */
    private async ownsInstallation(userId: string, installationEntityId: string): Promise<boolean> {
        const installation = await this.loadInstallation(installationEntityId);
        return Boolean(installation && installation.createdByUserId === userId);
    }

    private async loadInstallation(installationEntityId: string) {
        let installation: Awaited<ReturnType<GitHubAppInstallationRepository['findById']>>;
        try {
            installation = await this.installations.findById(installationEntityId);
        } catch {
            return null;
        }
        if (!installation) return null;
        if (installation.deletedAt || installation.suspendedAt) return null;
        return installation;
    }

    /**
     * The repositories this job may push to, from the job's OWN payload.
     *
     * The payload is written by the planner and is never writable by a
     * node, so reading it here is the platform re-reading its own decision
     * — the posture `FleetRunCredentialService` already takes with
     * `payload.mcp.enabled`. Read-only mounts are excluded: a credential
     * that could write a reference checkout is a credential wider than the
     * run.
     *
     * WHAT THIS IS NOT. These names are a SELECTOR, never an authority.
     * Nothing they say reaches GitHub: {@link resolveScope} turns each one
     * into a numeric repository id read from the platform's own
     * installation snapshot, and refuses any that does not resolve to an
     * installation THIS JOB'S OWNER controls. So the worst a tampered
     * payload could buy — and tampering means write access to `fleet_jobs`,
     * which is already game over — is a token for another of that same
     * owner's own repositories. It can never reach a repository, an
     * installation or an account the owner does not already hold.
     */
    private repositoriesOf(job: {
        payload?: Record<string, unknown> | null;
    }): FleetPushRepositoryRequest[] {
        const workspace = (
            job.payload as { workspace?: Record<string, unknown> } | null | undefined
        )?.workspace;
        if (!workspace || typeof workspace !== 'object') return [];
        const out: FleetPushRepositoryRequest[] = [];
        // The clone URL rides along with the name wherever the planner wrote
        // one: see {@link pushTargetOf} for why the name alone is not an
        // identity a write credential may be scoped by.
        if (typeof workspace.repositoryId === 'string') {
            out.push({
                repositoryId: workspace.repositoryId,
                repoUrl: typeof workspace.repoUrl === 'string' ? workspace.repoUrl : null,
            });
        }
        const mounts = Array.isArray(workspace.mounts) ? workspace.mounts : [];
        for (const mount of mounts) {
            if (!mount || typeof mount !== 'object') continue;
            const entry = mount as {
                repositoryId?: unknown;
                repoUrl?: unknown;
                writable?: unknown;
            };
            if (entry.writable === false) continue;
            if (typeof entry.repositoryId === 'string') {
                out.push({
                    repositoryId: entry.repositoryId,
                    repoUrl: typeof entry.repoUrl === 'string' ? entry.repoUrl : null,
                });
            }
        }
        return out;
    }

    /** `git.push !== false` on the plan the platform itself wrote. */
    private jobPushes(job: { payload?: Record<string, unknown> | null }): boolean {
        const git = (job.payload as { git?: { push?: unknown } } | null | undefined)?.git;
        return !git || git.push !== false;
    }

    /**
     * Who this commit is by, entirely from platform rows.
     *
     * Nothing here reads free text off the payload: the node name comes
     * from the `fleet_nodes` row, the Agent name and email from the
     * `agents` row (the same `committerName` / `committerEmail` ?? slug
     * convention the cloud commit tool uses), and the ids from the job
     * row. The only payload reads are the `agentId` and `runId` KEYS,
     * which are ids the platform wrote and which are re-validated by the
     * contracts composer before they can appear in a trailer.
     */
    private async describeAttribution(
        claim: { jobId: string; userId: string; nodeId: string },
        job: { payload?: Record<string, unknown> | null },
    ): Promise<FleetPushAttribution> {
        const node = await this.nodes.findById(claim.nodeId);
        const payload = (job.payload ?? {}) as { agentId?: unknown; runId?: unknown };
        const agentId =
            typeof payload.agentId === 'string' && payload.agentId ? payload.agentId : null;
        const runId = typeof payload.runId === 'string' && payload.runId ? payload.runId : null;

        let agentName: string | null = null;
        let agentEmail: string | null = null;
        if (agentId && this.agents) {
            try {
                // Scoped to the JOB's owner, never to anything the caller
                // sent: an authenticated node must not be able to name
                // another tenant's Agent on a commit.
                const agent = await this.agents.findByIdAndUser(agentId, claim.userId);
                if (agent) {
                    agentName =
                        sanitizeFleetPushIdentityText(agent.committerName || agent.name, 48) ||
                        null;
                    agentEmail =
                        agent.committerEmail ||
                        (agent.slug ? `${agent.slug}@agents.ever.works` : null);
                }
            } catch {
                // Attribution degrades to ids; it never fails a run.
                agentName = null;
                agentEmail = null;
            }
        }

        return {
            nodeId: claim.nodeId,
            nodeName: sanitizeFleetPushIdentityText(node?.name, 48),
            agentId,
            agentName,
            agentEmail,
            jobId: claim.jobId,
            runId,
        };
    }

    private appCredentials(): { appId: string; privateKey: string } | null {
        const appId = config.githubApp.getAppId();
        const privateKey = config.githubApp.getPrivateKey();
        if (!appId || !privateKey) return null;
        return { appId, privateKey };
    }

    /** Log the refusal (job + stable token only) and build the error to throw. */
    private refusal(jobId: string, reason: string): FleetPushCredentialError {
        this.logger.warn(`Fleet job ${jobId}: scoped push credential refused — ${reason}`);
        return new FleetPushCredentialError(reason);
    }
}
