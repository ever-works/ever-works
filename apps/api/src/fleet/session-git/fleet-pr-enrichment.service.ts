import { Injectable, Logger } from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import { GitFacadeService, type GitFacadeOptions } from '@ever-works/agent/facades';
import {
    FleetCheckoutRepository,
    FleetCheckoutService,
    FleetSessionRepository,
    type FleetCheckout,
    type FleetCheckoutActor,
} from '@ever-works/agent/fleet';
import { requestGitHubAppInstallationAccessTokenDetails } from '@ever-works/agent/utils';
import {
    FLEET_CHECKOUT_GIT_LINE_REFRESH_MS,
    FLEET_PR_ENRICHMENT_MIN_INTERVAL_MS,
    FLEET_PR_ENRICHMENT_RECENT_MS,
    fleetPushRemoteRepositoryId,
    parseFleetGitLine,
    parseFleetRemote,
    type FleetCheckoutPullRequestFacts,
    type FleetGitLinePullRequest,
    type FleetGitLinePullRequestChecks,
    type FleetParsedRemote,
} from '@ever-works/contracts';
import { FleetPushCredentialService } from '../fleet-push-credential.service';

/** A checkout's pull request facts, as last asked — per API process (plan §4: not stored). */
interface CachedFacts {
    facts: FleetCheckoutPullRequestFacts;
    /** Epoch ms of the last provider ask (success or failure). */
    at: number;
    /** The branch they were resolved for. */
    branch: string | null;
}

/** Live-session checkouts are asked every minute; a checkout with only a recent pull request every ten. */
const RECENT_ONLY_INTERVAL_MS = 10 * 60_000;
/** Most checkouts one tick asks the provider about (GitHub's hourly budget is per installation). */
const ENRICH_PER_TICK = 80;
/** The repository's default branch changes rarely: asked at most hourly. */
const DEFAULT_BRANCH_TTL_MS = 60 * 60_000;
/** A minted installation token is reused until five minutes before it lapses. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** A session that stopped working this recently gets its one closing refresh (spec FR-11). */
const STOP_WINDOW_MS = FLEET_CHECKOUT_GIT_LINE_REFRESH_MS + 30_000;

function appCredentials(): { appId: string; privateKey: string } | null {
    const appId = config.githubApp.getAppId();
    const privateKey = config.githubApp.getPrivateKey();
    if (!appId || !privateKey) return null;
    return { appId, privateKey };
}

function checksOf(ciState: unknown): FleetGitLinePullRequestChecks | null {
    return ciState === 'passing' || ciState === 'failing' || ciState === 'pending' ? ciState : null;
}

function httpsUrl(value: unknown): string | null {
    return typeof value === 'string' && /^https:\/\//.test(value) && value.length <= 2048
        ? value
        : null;
}

function emptyFacts(
    checkoutId: string,
    pr: FleetGitLinePullRequest | null,
): FleetCheckoutPullRequestFacts {
    return {
        checkoutId,
        pr,
        unresolvedComments: null,
        mergeable: null,
        baseRef: null,
        defaultBranch: null,
        checkedAt: null,
        unknownSince: null,
    };
}

/**
 * Session git & actions (FL-06, spec FR-7, FR-8, U12; plan §10) — the
 * pull request beside a checkout's git line, resolved by the platform through
 * the GitHub App and written onto the line's `pr` (the CONTRACTS §4.7 fields
 * only) by `FleetCheckoutService.setPullRequest`, the one writer of
 * `fleet_checkouts`.
 *
 * For a checkout on a github.com remote with a branch: the pull request whose
 * head is that branch (an open one first, else the latest), its state and
 * checks roll-up, and — kept here only, for the relevance rules — its
 * mergeability, its open review comments and the repository's default
 * branch. At most one provider ask per checkout per minute; a failure keeps
 * the last good answer and starts `unknownSince` ("PR: unknown (GitHub
 * unreachable 3 min)").
 *
 * Credentials: an installation token of the Node owner's GitHub App
 * installation, narrowed to that one repository (the push-credential scope
 * resolver, platform state only), reused until it nears its expiry and never
 * logged; without an installation, the owner's own connected GitHub account
 * through the git facade. No path here merges anything (spec FR-20).
 *
 * The same minute tick drives the git-line cadence (spec FR-11): every
 * checkout a session is WORKING in is recomputed on its computer each minute,
 * and once more when the session stops.
 */
@Injectable()
export class FleetPrEnrichmentService {
    private readonly logger = new Logger(FleetPrEnrichmentService.name);
    private readonly cache = new Map<string, CachedFacts>();
    private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
    private readonly defaults = new Map<string, { branch: string | null; at: number }>();
    /** Sessions whose closing refresh already ran, by id → when. */
    private readonly stopRefreshed = new Map<string, number>();
    private readonly now: () => number = () => Date.now();

    constructor(
        private readonly checkouts: FleetCheckoutService,
        private readonly rows: FleetCheckoutRepository,
        private readonly sessions: FleetSessionRepository,
        private readonly git: GitFacadeService,
        private readonly push: FleetPushCredentialService,
    ) {}

    /**
     * `GET /api/fleet/checkouts/:id/pull-request` (plan §5): the checkout's
     * pull request facts — the `view` audience first (a stranger reads 404),
     * then the provider, at most once per minute.
     */
    async factsFor(id: string, actor: FleetCheckoutActor): Promise<FleetCheckoutPullRequestFacts> {
        await this.checkouts.get(id, actor);
        const row = await this.rows.findById(id);
        if (!row) return emptyFacts(id, null);
        return this.enrich(row);
    }

    /** The facts the relevance rules read (P2): cached, asked once on a miss. Never throws. */
    async cachedFacts(row: FleetCheckout): Promise<FleetCheckoutPullRequestFacts> {
        try {
            return await this.enrich(row);
        } catch {
            return emptyFacts(row.id, parseFleetGitLine(row.gitLine ?? null)?.pr ?? null);
        }
    }

    /** Forget a checkout's cached facts (after the platform opened or updated its pull request). */
    invalidate(checkoutId: string): void {
        this.cache.delete(checkoutId);
    }

    /**
     * Resolve one checkout's pull request (spec FR-7). `minIntervalMs` bounds
     * how often the provider is asked for it (a minute by default).
     */
    async enrich(
        row: FleetCheckout,
        options: { minIntervalMs?: number; force?: boolean } = {},
    ): Promise<FleetCheckoutPullRequestFacts> {
        const line = parseFleetGitLine(row.gitLine ?? null);
        const branch = line?.branch ?? row.branch ?? null;
        const now = this.now();
        const cached = this.cache.get(row.id);
        const interval = options.minIntervalMs ?? FLEET_PR_ENRICHMENT_MIN_INTERVAL_MS;
        if (cached && cached.branch === branch && !options.force && now - cached.at < interval)
            return cached.facts;
        const remote = parseFleetRemote(row.remoteUrl ?? null);
        if (!branch || !remote || remote.host !== 'github.com') {
            // Another provider, no remote, a detached head: nothing to ask (GitLab and others are out of scope, §8).
            return emptyFacts(row.id, line?.pr ?? null);
        }
        try {
            const access = await this.accessFor(row.userId, remote);
            const listed = await this.git.listPullRequests(
                remote.owner,
                remote.repo,
                { state: 'all', head: `${remote.owner}:${branch}`, perPage: 10 },
                access,
            );
            const candidates = listed.filter(
                (pr) => pr.head === branch || pr.head.endsWith(`:${branch}`) || !pr.head,
            );
            const pick =
                candidates.find((pr) => pr.state === 'open') ??
                [...candidates].sort(
                    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
                )[0] ??
                null;
            let pr: FleetGitLinePullRequest | null = null;
            let mergeable: boolean | null = null;
            let unresolvedComments: number | null = null;
            let baseRef: string | null = null;
            if (pick) {
                let status: Awaited<ReturnType<GitFacadeService['getPullRequestStatus']>> = null;
                try {
                    status = await this.git.getPullRequestStatus(
                        remote.owner,
                        remote.repo,
                        pick.number,
                        access,
                    );
                } catch (error) {
                    this.logger.debug(
                        `Pull request ${remote.owner}/${remote.repo}#${pick.number} status unreadable: ${
                            error instanceof Error ? error.name : 'error'
                        }`,
                    );
                }
                const state = status?.state ?? pick.state;
                const url = httpsUrl(status?.url) ?? httpsUrl(pick.url);
                if (url)
                    pr = { number: pick.number, state, checks: checksOf(status?.ciState), url };
                mergeable = typeof status?.mergeable === 'boolean' ? status.mergeable : null;
                baseRef = status?.baseRef ?? pick.base ?? null;
                if (state === 'open' || state === 'draft') {
                    try {
                        const comments = await this.git.listPullRequestReviewComments(
                            remote.owner,
                            remote.repo,
                            pick.number,
                            access,
                        );
                        // A comment still anchored to a line of the current diff is still open; an
                        // outdated one (no line) was addressed by a later push (lane-log decision).
                        unresolvedComments = comments.filter(
                            (comment) => comment.line !== null,
                        ).length;
                    } catch {
                        unresolvedComments = null;
                    }
                } else {
                    unresolvedComments = 0;
                }
            }
            const defaultBranch = await this.defaultBranchOf(remote, access);
            const facts: FleetCheckoutPullRequestFacts = {
                checkoutId: row.id,
                pr,
                unresolvedComments,
                mergeable,
                baseRef: baseRef ?? defaultBranch,
                defaultBranch,
                checkedAt: new Date(now).toISOString(),
                unknownSince: null,
            };
            await this.checkouts.setPullRequest(row.id, branch, pr);
            this.remember(row.id, { facts, at: now, branch });
            return facts;
        } catch (error) {
            const previous = cached?.branch === branch ? cached.facts : null;
            const facts: FleetCheckoutPullRequestFacts = {
                checkoutId: row.id,
                pr: line?.pr ?? null,
                unresolvedComments: previous?.unresolvedComments ?? null,
                mergeable: previous?.mergeable ?? null,
                baseRef: previous?.baseRef ?? null,
                defaultBranch: previous?.defaultBranch ?? null,
                checkedAt: previous?.checkedAt ?? null,
                unknownSince: previous?.unknownSince ?? new Date(now).toISOString(),
            };
            this.remember(row.id, { facts, at: now, branch });
            this.logger.debug(
                `Pull request of checkout ${row.id} could not be resolved: ${
                    error instanceof Error ? error.name : 'error'
                }`,
            );
            return facts;
        }
    }

    /**
     * The minute tick (plan §10, spec FR-7, FR-11): the git-line cadence of
     * every checkout a session works in, then the pull request of those
     * checkouts (every minute) and of checkouts whose pull request was seen in
     * the last week (every ten minutes). Bounded; never throws.
     */
    async tick(): Promise<{ refreshed: number; enriched: number }> {
        const now = this.now();
        let refreshed = 0;
        let enriched = 0;
        const sessions = await this.sessions.findWithCheckoutForCadence(
            new Date(now - STOP_WINDOW_MS),
            500,
        );
        const byNode = new Map<string, Set<string>>();
        const live = new Set<string>();
        for (const session of sessions) {
            if (!session.checkoutId) continue;
            if (session.state !== 'ended') live.add(session.checkoutId);
            const working = session.state === 'working';
            const changedAt = session.stateChangedAt
                ? new Date(session.stateChangedAt).getTime()
                : 0;
            const justStopped =
                !working && now - changedAt < STOP_WINDOW_MS && !this.stopRefreshed.has(session.id);
            if (!working && !justStopped) continue;
            if (justStopped) this.stopRefreshed.set(session.id, now);
            const ids = byNode.get(session.nodeId) ?? new Set<string>();
            ids.add(session.checkoutId);
            byNode.set(session.nodeId, ids);
        }
        for (const [key, at] of this.stopRefreshed)
            if (now - at > 10 * STOP_WINDOW_MS) this.stopRefreshed.delete(key);
        for (const [nodeId, ids] of byNode) {
            const result = await this.checkouts.refreshForSessions(nodeId, [...ids]);
            refreshed += result.refreshed;
        }

        const liveRows = await this.rows.findByIds([...live]);
        const recentRows = await this.rows.findWithPullRequestSince(
            new Date(now - FLEET_PR_ENRICHMENT_RECENT_MS),
            300,
        );
        const seen = new Set<string>();
        const queue: Array<{ row: FleetCheckout; interval: number }> = [];
        for (const row of liveRows) {
            if (row.state !== 'ready' || seen.has(row.id)) continue;
            seen.add(row.id);
            queue.push({ row, interval: FLEET_PR_ENRICHMENT_MIN_INTERVAL_MS });
        }
        for (const row of recentRows) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            queue.push({ row, interval: RECENT_ONLY_INTERVAL_MS });
        }
        for (const entry of queue.slice(0, ENRICH_PER_TICK)) {
            const before = this.cache.get(entry.row.id)?.at;
            await this.enrich(entry.row, { minIntervalMs: entry.interval - 5_000 });
            if (this.cache.get(entry.row.id)?.at !== before) enriched += 1;
        }
        return { refreshed, enriched };
    }

    /** An installation token for one repository, else the owner's own account (the facade resolves it). */
    async accessFor(userId: string, remote: FleetParsedRemote): Promise<GitFacadeOptions> {
        const repoUrl = `https://${remote.host}/${remote.owner}/${remote.repo}`;
        const repositoryId = fleetPushRemoteRepositoryId(repoUrl);
        const credentials = appCredentials();
        if (repositoryId && credentials) {
            const key = `${userId}:${repositoryId}`;
            const known = this.tokens.get(key);
            if (known && known.expiresAt - this.now() > TOKEN_MARGIN_MS) {
                return { providerId: 'github', token: known.token, userId };
            }
            const scope = await this.push.describeScope(userId, [{ repositoryId, repoUrl }]);
            if (scope.ok) {
                const minted = await requestGitHubAppInstallationAccessTokenDetails(
                    scope.installationId,
                    credentials,
                    {
                        repositoryIds: scope.repositoryIds,
                    },
                );
                if (minted.token) {
                    const expiresAt = minted.expiresAt ? Date.parse(minted.expiresAt) : NaN;
                    this.tokens.set(key, {
                        token: minted.token,
                        expiresAt: Number.isFinite(expiresAt)
                            ? expiresAt
                            : this.now() + 55 * 60_000,
                    });
                    if (this.tokens.size > 2000) {
                        for (const [entry, value] of this.tokens) {
                            if (value.expiresAt - this.now() <= TOKEN_MARGIN_MS)
                                this.tokens.delete(entry);
                        }
                    }
                    return { providerId: 'github', token: minted.token, userId };
                }
            }
        }
        return { providerId: 'github', userId };
    }

    private async defaultBranchOf(
        remote: FleetParsedRemote,
        access: GitFacadeOptions,
    ): Promise<string | null> {
        const key = `${remote.host}/${remote.fullName}`;
        const known = this.defaults.get(key);
        if (known && this.now() - known.at < DEFAULT_BRANCH_TTL_MS) return known.branch;
        try {
            const repository = await this.git.getRepository(remote.owner, remote.repo, access);
            const branch = repository?.defaultBranch || null;
            this.defaults.set(key, { branch, at: this.now() });
            return branch;
        } catch {
            return known?.branch ?? null;
        }
    }

    private remember(checkoutId: string, entry: CachedFacts): void {
        this.cache.set(checkoutId, entry);
        if (this.cache.size > 5000) {
            const cutoff = this.now() - RECENT_ONLY_INTERVAL_MS * 2;
            for (const [key, value] of this.cache) if (value.at < cutoff) this.cache.delete(key);
        }
    }
}
