import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    isActionsRunnersApiError,
    isActionsRunnersPlugin,
    PLUGIN_CAPABILITIES,
    type ActionsJobsPage,
    type ActionsRunnerDownload,
    type ActionsRunnerOneTimeToken,
    type ActionsRunnersPage,
    type ActionsRunnersPermissionCheck,
    type IActionsRunnersPlugin,
    type IPlugin,
} from '@ever-works/plugin';
import { config } from '../config';
import { GitHubAppInstallationRepoRepository } from '../database/repositories/github-app-installation-repository.repository';
import { GitHubAppInstallationRepository } from '../database/repositories/github-app-installation.repository';
import type { GitHubAppInstallation } from '../entities/github-app-installation.entity';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import {
    requestGitHubAppInstallationAccessTokenDetails,
    type GitHubAppCredentials,
    type GitHubAppInstallationAccessToken,
    type GitHubAppInstallationTokenScope,
} from '../utils/github-app.utils';
import { BaseFacadeService, FacadeError } from './base.facade';

/**
 * Why an Actions-runners call could not be made. Matched by `reason` (and
 * the class by name) — the message is for logs only and never carries a token.
 *
 *  - `no-provider` — no `actions-runners` plugin is enabled;
 *  - `not-configured` — the deployment has no GitHub App credentials;
 *  - `not-covered` — no live installation of THIS person covers the target (U7);
 *  - `permission-missing` — the installation lacks the permission (`missing`, `grantUrl`, U8, S7);
 *  - `rate-limited` — GitHub is rate-limiting (`rateLimitedUntil`, U17);
 *  - `github` — GitHub refused or failed (the first line of its message).
 */
export type ActionsRunnersFailureReason =
    | 'no-provider'
    | 'not-configured'
    | 'not-covered'
    | 'permission-missing'
    | 'rate-limited'
    | 'not-found'
    | 'github';

export class ActionsRunnersFacadeError extends FacadeError {
    constructor(
        message: string,
        operation: string,
        readonly reason: ActionsRunnersFailureReason,
        readonly extra: {
            missing?: string;
            grantUrl?: string | null;
            rateLimitedUntil?: string | null;
        } = {},
    ) {
        super(message, operation);
        this.name = 'ActionsRunnersFacadeError';
    }
}

/** A repository or organisation one of the person's live installations covers. */
export interface ActionsRunnersTarget {
    scope: 'org' | 'repo';
    /** `owner/repo` or `org`. */
    target: string;
    installationEntityId: string;
    /** GitHub's own numeric installation id (what the mint URL uses). */
    installationId: string;
    accountLogin: string;
    /** `Organization` · `User`. */
    targetType: string;
    /** Repository targets: GitHub's numeric repository id, from the platform's own snapshot. */
    repositoryId: string | null;
}

/** What a token is minted for — each maps to the narrowest permission that works (plan §3). */
export type ActionsRunnersTokenPurpose =
    | 'runners-read'
    | 'runners-write'
    | 'jobs-read'
    | 'runs-write';

/** The permission object for one purpose on one scope (spec FR-7: the narrowest that works). */
export function actionsRunnersPermissionsFor(
    scope: 'org' | 'repo',
    purpose: ActionsRunnersTokenPurpose,
): Record<string, string> {
    switch (purpose) {
        case 'runners-read':
            return scope === 'org'
                ? { organization_self_hosted_runners: 'read' }
                : { administration: 'read' };
        case 'runners-write':
            return scope === 'org'
                ? { organization_self_hosted_runners: 'write' }
                : { administration: 'write' };
        case 'jobs-read':
            return { actions: 'read' };
        case 'runs-write':
            return { actions: 'write' };
    }
}

/** The GitHub permission's display name, for "needs the permission …" (spec S7, U8). */
export function actionsRunnersPermissionLabel(
    scope: 'org' | 'repo',
    purpose: ActionsRunnersTokenPurpose,
): string {
    if (purpose === 'jobs-read') return 'Actions: Read-only';
    if (purpose === 'runs-write') return 'Actions: Read and write';
    return scope === 'org'
        ? 'Self-hosted runners: Read and write'
        : 'Administration: Read and write';
}

/** The installation's page on GitHub, where its permissions are granted ("Grant access", spec §5.6). */
export function actionsRunnersGrantUrl(
    installation: Pick<GitHubAppInstallation, 'installationId' | 'accountLogin' | 'targetType'>,
): string {
    const id = encodeURIComponent(installation.installationId);
    return installation.targetType === 'Organization'
        ? `https://github.com/organizations/${encodeURIComponent(installation.accountLogin)}/settings/installations/${id}`
        : `https://github.com/settings/installations/${id}`;
}

type Minter = (
    installationId: string,
    credentials: GitHubAppCredentials,
    scope?: GitHubAppInstallationTokenScope,
) => Promise<GitHubAppInstallationAccessToken>;

/**
 * Actions runners on computers (FL-18, CONTRACTS R-14, plan §7) — the facade
 * for the `actions-runners` capability.
 *
 * Owns the one thing the plugin must never hold: the GitHub App credential.
 * For every call it resolves WHICH of the person's installations covers the
 * target (the installation snapshot tables, with the ownership filter the
 * push credential uses — created by this person, neither suspended nor
 * deleted), mints an installation token narrowed to the ONE permission the
 * call needs (and, for a repository, to that repository's id from the
 * snapshot — never a caller-supplied name), and hands it to the plugin for
 * that call only. The token is never logged, stored or returned, except the
 * runner's one-time registration / remove token, which the caller hands to
 * the node exactly once.
 *
 * The plugin is resolved by capability; no core file names its id.
 */
@Injectable()
export class ActionsRunnersFacadeService extends BaseFacadeService {
    protected readonly logger = new Logger(ActionsRunnersFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.ACTIONS_RUNNERS;

    /** The installation token minter (a test replaces it). */
    protected minter: Minter = requestGitHubAppInstallationAccessTokenDetails;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
        @Optional() private readonly installations?: GitHubAppInstallationRepository,
        @Optional() private readonly installationRepos?: GitHubAppInstallationRepoRepository,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    /** True when a provider is enabled for this person and the deployment has GitHub App credentials. */
    async isAvailable(userId: string): Promise<boolean> {
        if (!this.appCredentials()) return false;
        try {
            await this.resolveTypedPlugin(userId);
            return true;
        } catch {
            return false;
        }
    }

    // ─── Targets (spec FR-2) ─────────────────────────────────────────────

    /** The person's live installations (created by them, neither suspended nor deleted). */
    async liveInstallations(userId: string): Promise<GitHubAppInstallation[]> {
        if (!this.installations) return [];
        const rows = await this.installations.listByCreatedByUserId(userId).catch(() => []);
        return rows.filter(
            (row) => !row.deletedAt && !row.suspendedAt && row.createdByUserId === userId,
        );
    }

    /**
     * Every repository and organisation the person's live installations cover:
     * an organisation installation offers the organisation itself; every
     * installation offers its repositories from the platform's snapshot.
     */
    async listTargets(userId: string): Promise<ActionsRunnersTarget[]> {
        const out: ActionsRunnersTarget[] = [];
        const seen = new Set<string>();
        for (const installation of await this.liveInstallations(userId)) {
            if (installation.targetType === 'Organization') {
                const key = `org:${installation.accountLogin.toLowerCase()}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push(this.targetOf(installation, 'org', installation.accountLogin, null));
                }
            }
            const repos = this.installationRepos
                ? await this.installationRepos.listForInstallation(installation.id).catch(() => [])
                : [];
            for (const repo of repos) {
                if (repo.selected === false) continue;
                const key = `repo:${repo.fullName.toLowerCase()}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(this.targetOf(installation, 'repo', repo.fullName, repo.githubRepoId));
            }
        }
        return out.sort((a, b) =>
            a.scope === b.scope ? a.target.localeCompare(b.target) : a.scope === 'repo' ? -1 : 1,
        );
    }

    /**
     * The ONE live installation of this person covering `target`, or a
     * `not-covered` refusal (U7). Two installations covering the same target
     * is refused too: which one's audit trail a registration lands in must not
     * be decided by listing order.
     */
    async resolveTarget(
        userId: string,
        scope: 'org' | 'repo',
        target: string,
    ): Promise<ActionsRunnersTarget> {
        const wanted = target.toLowerCase();
        const matches = (await this.listTargets(userId)).filter(
            (entry) => entry.scope === scope && entry.target.toLowerCase() === wanted,
        );
        const byInstallation = new Map(matches.map((entry) => [entry.installationEntityId, entry]));
        if (byInstallation.size !== 1) {
            throw new ActionsRunnersFacadeError(
                byInstallation.size === 0
                    ? `install the Ever Works GitHub App on ${target} first`
                    : `more than one of your GitHub App installations covers ${target}`,
                'resolveTarget',
                'not-covered',
            );
        }
        return [...byInstallation.values()][0];
    }

    /** The installation behind a stored runner (its `installationEntityId`), still live and still this person's. */
    async targetForInstallation(
        userId: string,
        installationEntityId: string | null | undefined,
        scope: 'org' | 'repo',
        target: string,
    ): Promise<ActionsRunnersTarget> {
        const resolved = await this.resolveTarget(userId, scope, target);
        if (installationEntityId && resolved.installationEntityId !== installationEntityId) {
            // The installation that registered it is gone; the one covering it now answers.
            this.logger.debug(`actions runners: ${target} is now covered by another installation`);
        }
        return resolved;
    }

    // ─── Token minting (spec FR-7) ───────────────────────────────────────

    /**
     * An installation token for ONE call, narrowed to the purpose's permission
     * and, for a repository (or a jobs / runs call), to the repositories' ids
     * from the snapshot. A GitHub refusal of the narrowed permission (422 /
     * 403) is `permission-missing` with the exact permission and the
     * installation's page.
     */
    async mintToken(
        resolved: ActionsRunnersTarget,
        purpose: ActionsRunnersTokenPurpose,
        repositoryIds?: readonly string[],
    ): Promise<string> {
        const credentials = this.appCredentials();
        if (!credentials) {
            throw new ActionsRunnersFacadeError(
                'the GitHub App is not configured on this deployment',
                'mintToken',
                'not-configured',
            );
        }
        const ids = repositoryIds ?? (resolved.repositoryId ? [resolved.repositoryId] : []);
        const scope: GitHubAppInstallationTokenScope = {
            permissions: actionsRunnersPermissionsFor(resolved.scope, purpose),
            ...(ids.length > 0 &&
            (resolved.scope === 'repo' || purpose === 'jobs-read' || purpose === 'runs-write')
                ? { repositoryIds: [...ids] }
                : {}),
        };
        try {
            const minted = await this.minter(resolved.installationId, credentials, scope);
            return minted.token;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // The minter's message names the status only; never the key or a token.
            if (/\b(403|422)\b/.test(message)) {
                throw new ActionsRunnersFacadeError(
                    `the Ever Works GitHub App on ${resolved.accountLogin} needs "${actionsRunnersPermissionLabel(resolved.scope, purpose)}"`,
                    'mintToken',
                    'permission-missing',
                    {
                        missing: actionsRunnersPermissionLabel(resolved.scope, purpose),
                        grantUrl: actionsRunnersGrantUrl({
                            installationId: resolved.installationId,
                            accountLogin: resolved.accountLogin,
                            targetType: resolved.targetType,
                        }),
                    },
                );
            }
            this.logger.warn(
                `actions runners: installation token for ${resolved.target} not minted (${message.slice(0, 120)})`,
            );
            throw new ActionsRunnersFacadeError(
                'GitHub did not hand over an installation token',
                'mintToken',
                'github',
            );
        }
    }

    // ─── Plugin calls (each with its own narrowed token) ─────────────────

    async listDownloads(
        userId: string,
        resolved: ActionsRunnersTarget,
    ): Promise<ActionsRunnerDownload[]> {
        const plugin = await this.resolveTypedPlugin(userId);
        const token = await this.mintToken(resolved, 'runners-read');
        return this.call('listDownloads', resolved, () =>
            plugin.listDownloads(this.pluginTarget(resolved), token),
        );
    }

    /** The runner's one-time registration token — handed to the node once, never stored or logged. */
    async mintRegistrationToken(
        userId: string,
        resolved: ActionsRunnersTarget,
    ): Promise<ActionsRunnerOneTimeToken> {
        const plugin = await this.resolveTypedPlugin(userId);
        const token = await this.mintToken(resolved, 'runners-write');
        return this.call('mintRegistrationToken', resolved, () =>
            plugin.mintRegistrationToken(this.pluginTarget(resolved), token),
        );
    }

    /** The runner's one-time remove token — handed to the node once, never stored or logged. */
    async mintRemoveToken(
        userId: string,
        resolved: ActionsRunnersTarget,
    ): Promise<ActionsRunnerOneTimeToken> {
        const plugin = await this.resolveTypedPlugin(userId);
        const token = await this.mintToken(resolved, 'runners-write');
        return this.call('mintRemoveToken', resolved, () =>
            plugin.mintRemoveToken(this.pluginTarget(resolved), token),
        );
    }

    async listRunners(
        userId: string,
        resolved: ActionsRunnersTarget,
        etag?: string | null,
    ): Promise<ActionsRunnersPage> {
        const plugin = await this.resolveTypedPlugin(userId);
        const token = await this.mintToken(resolved, 'runners-read');
        return this.call('listRunners', resolved, () =>
            plugin.listRunners(this.pluginTarget(resolved), token, { etag }),
        );
    }

    async deleteRunner(
        userId: string,
        resolved: ActionsRunnersTarget,
        githubRunnerId: number,
    ): Promise<void> {
        const plugin = await this.resolveTypedPlugin(userId);
        const token = await this.mintToken(resolved, 'runners-write');
        await this.call('deleteRunner', resolved, () =>
            plugin.deleteRunner(this.pluginTarget(resolved), githubRunnerId, token),
        );
    }

    /**
     * The queued and running self-hosted jobs of a target (P2). An organisation
     * target reads the repositories of its installation that `repositories`
     * names (each must be in the snapshot).
     */
    async listJobs(
        userId: string,
        resolved: ActionsRunnersTarget,
        options: {
            etag?: string | null;
            repositories?: Array<{ fullName: string; githubRepoId: string }>;
        } = {},
    ): Promise<ActionsJobsPage> {
        const plugin = await this.resolveTypedPlugin(userId);
        const ids =
            resolved.scope === 'repo'
                ? resolved.repositoryId
                    ? [resolved.repositoryId]
                    : []
                : (options.repositories ?? []).map((repo) => repo.githubRepoId);
        const token = await this.mintToken(resolved, 'jobs-read', ids);
        return this.call('listJobs', resolved, () =>
            plugin.listJobs(this.pluginTarget(resolved), token, {
                etag: options.etag,
                repositories: (options.repositories ?? []).map((repo) => repo.fullName),
            }),
        );
    }

    /** Cancel a whole workflow run of a repository the person's installation covers (P2, R-37). */
    async cancelRun(
        userId: string,
        resolvedRepository: ActionsRunnersTarget,
        runId: number,
    ): Promise<void> {
        const plugin = await this.resolveTypedPlugin(userId);
        const token = await this.mintToken(resolvedRepository, 'runs-write');
        await this.call('cancelRun', resolvedRepository, () =>
            plugin.cancelRun(resolvedRepository.target, runId, token),
        );
    }

    /** Whether the installation may manage runners for the target (FR-26): a narrowed mint is the probe. */
    async checkPermission(
        userId: string,
        resolved: ActionsRunnersTarget,
    ): Promise<ActionsRunnersPermissionCheck> {
        try {
            const plugin = await this.resolveTypedPlugin(userId);
            const token = await this.mintToken(resolved, 'runners-read');
            const answer = await plugin.checkPermission(this.pluginTarget(resolved), token);
            if (answer.ok) return { ok: true };
            return {
                ok: false,
                missing:
                    answer.missing ??
                    actionsRunnersPermissionLabel(resolved.scope, 'runners-write'),
                grantUrl: actionsRunnersGrantUrl({
                    installationId: resolved.installationId,
                    accountLogin: resolved.accountLogin,
                    targetType: resolved.targetType,
                }),
            };
        } catch (error) {
            if (
                error instanceof ActionsRunnersFacadeError &&
                error.reason === 'permission-missing'
            ) {
                return {
                    ok: false,
                    missing: error.extra.missing,
                    grantUrl: error.extra.grantUrl ?? undefined,
                };
            }
            throw error;
        }
    }

    /** The snapshot repositories of an installation (an organisation's jobs read, P2). */
    async repositoriesOf(
        installationEntityId: string,
    ): Promise<Array<{ fullName: string; githubRepoId: string }>> {
        if (!this.installationRepos) return [];
        const rows = await this.installationRepos
            .listForInstallation(installationEntityId)
            .catch(() => []);
        return rows
            .filter((row) => row.selected !== false)
            .map((row) => ({ fullName: row.fullName, githubRepoId: row.githubRepoId }));
    }

    // ─── Watched targets (P2, FR-21) — the person's own plugin setting ────

    /**
     * The repositories and organisations this person's Actions jobs panel
     * watches, from the plugin's user-scope `watchedTargets` setting (plan §7:
     * non-secret, the person's own). Null when nothing was saved (the panel
     * then watches every target the person has runners for) or no provider is
     * enabled. Entries are `repo:owner/name` or `org:login`.
     */
    async getWatchedTargets(
        userId: string,
    ): Promise<Array<{ scope: 'org' | 'repo'; target: string }> | null> {
        if (!this.settingsService) return null;
        let plugin: IActionsRunnersPlugin;
        try {
            plugin = await this.resolveTypedPlugin(userId);
        } catch {
            return null;
        }
        const settings = await this.settingsService
            .getSettings(plugin.id, { userId })
            .catch(() => null);
        const raw = settings?.watchedTargets;
        if (!Array.isArray(raw)) return null;
        const out: Array<{ scope: 'org' | 'repo'; target: string }> = [];
        for (const entry of raw) {
            if (typeof entry !== 'string') continue;
            const colon = entry.indexOf(':');
            const scope = entry.slice(0, colon);
            const target = entry.slice(colon + 1);
            if ((scope === 'org' || scope === 'repo') && target) out.push({ scope, target });
        }
        // An empty saved list is "the default" (every target the person has runners for).
        return out.length > 0 ? out : null;
    }

    /** Save (or, with `null`, clear back to the default) this person's watched targets. */
    async setWatchedTargets(
        userId: string,
        targets: ReadonlyArray<{ scope: 'org' | 'repo'; target: string }> | null,
    ): Promise<void> {
        if (!this.settingsService) {
            throw new ActionsRunnersFacadeError(
                'settings are not available on this deployment',
                'setWatchedTargets',
                'not-configured',
            );
        }
        const plugin = await this.resolveTypedPlugin(userId);
        await this.settingsService.updateUserSettings(plugin.id, userId, {
            watchedTargets: targets ? targets.map((entry) => `${entry.scope}:${entry.target}`) : [],
        });
    }

    // ─── Shared ──────────────────────────────────────────────────────────

    private targetOf(
        installation: GitHubAppInstallation,
        scope: 'org' | 'repo',
        target: string,
        repositoryId: string | null,
    ): ActionsRunnersTarget {
        return {
            scope,
            target,
            installationEntityId: installation.id,
            installationId: installation.installationId,
            accountLogin: installation.accountLogin,
            targetType: installation.targetType,
            repositoryId,
        };
    }

    private pluginTarget(resolved: ActionsRunnersTarget): {
        scope: 'org' | 'repo';
        target: string;
    } {
        return { scope: resolved.scope, target: resolved.target };
    }

    private async resolveTypedPlugin(userId: string): Promise<IActionsRunnersPlugin> {
        let plugin: IPlugin;
        try {
            plugin = await this.resolvePlugin<IPlugin>(undefined, userId);
        } catch {
            throw new ActionsRunnersFacadeError(
                'Actions runners are not available on this deployment',
                'resolve',
                'no-provider',
            );
        }
        if (!isActionsRunnersPlugin(plugin)) {
            throw new ActionsRunnersFacadeError(
                `Plugin ${plugin.id} does not implement actions-runners`,
                'resolve',
                'no-provider',
            );
        }
        return plugin;
    }

    /** Run one plugin call, mapping its typed refusal; the token never reaches a message. */
    private async call<T>(
        operation: string,
        resolved: ActionsRunnersTarget,
        run: () => Promise<T>,
    ): Promise<T> {
        try {
            return await run();
        } catch (error) {
            if (isActionsRunnersApiError(error)) {
                if (error.code === 'rate_limited') {
                    throw new ActionsRunnersFacadeError(error.message, operation, 'rate-limited', {
                        rateLimitedUntil: error.rateLimitedUntil,
                    });
                }
                if (error.code === 'permission') {
                    throw new ActionsRunnersFacadeError(
                        error.message,
                        operation,
                        'permission-missing',
                        {
                            missing: actionsRunnersPermissionLabel(resolved.scope, 'runners-write'),
                            grantUrl: actionsRunnersGrantUrl({
                                installationId: resolved.installationId,
                                accountLogin: resolved.accountLogin,
                                targetType: resolved.targetType,
                            }),
                        },
                    );
                }
                if (error.code === 'not_found')
                    throw new ActionsRunnersFacadeError(error.message, operation, 'not-found');
                throw new ActionsRunnersFacadeError(error.message, operation, 'github');
            }
            throw error;
        }
    }

    private appCredentials(): GitHubAppCredentials | null {
        const appId = config.githubApp.getAppId();
        const privateKey = config.githubApp.getPrivateKey();
        if (!appId || !privateKey) return null;
        return { appId, privateKey };
    }
}
