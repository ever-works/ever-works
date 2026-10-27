import type {
	ActionsJobsPage,
	ActionsRunnerDownload,
	ActionsRunnerOneTimeToken,
	ActionsRunnersPage,
	ActionsRunnersPermissionCheck,
	ActionsRunnerTarget,
	IActionsRunnersPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginHealthCheck
} from '@ever-works/plugin';
import { GitHubRunnersApi, type FetchLike } from './github-runners-api.js';

/** The plugin id (R-14). Core code resolves the plugin by capability, never by this id. */
export const GITHUB_ACTIONS_RUNNERS_PLUGIN_ID = 'github-actions-runners';

/** The exact GitHub permission an organisation's runners need (spec S7, FR-26). */
export const ORG_RUNNERS_PERMISSION = 'Self-hosted runners: Read and write';

/** The exact GitHub permission a repository's runners need. */
export const REPO_RUNNERS_PERMISSION = 'Administration: Read and write';

/**
 * The plugin's settings (P2, plan §7): only `watchedTargets`, the person's own
 * list of repositories and organisations the Actions jobs panel watches
 * (`repo:owner/name` · `org:login`, at most 20) — non-secret, user scope.
 * Empty means "every target I have runners for". Never a token.
 */
export const githubActionsRunnersSettingsSchema = {
	type: 'object',
	properties: {
		watchedTargets: {
			type: 'array',
			title: 'Watched repositories and organisations',
			description:
				'What the Actions jobs panel watches, as repo:owner/name or org:login. Empty: every repository and organisation you have runners for.',
			items: { type: 'string', maxLength: 210 },
			maxItems: 20,
			default: [],
			'x-scope': 'user'
		}
	},
	additionalProperties: false
} as JsonSchema;

/**
 * `github-actions-runners` — the first-party `actions-runners` provider
 * (FL-18, CONTRACTS R-14): GitHub's self-hosted runner API through the Ever
 * Works GitHub App.
 *
 * What it does, and nothing else: every method calls GitHub's REST API with
 * the short-lived installation token the platform minted for that call
 * (narrowed to the one permission it needs), and maps the answer. It holds no
 * credential between calls, has no credential setting (only the person's watched
 * list, P2), opens no connection on load and never logs a token. Installing and running the runner is the node's work.
 */
export class GitHubActionsRunnersPlugin implements IActionsRunnersPlugin {
	readonly id = GITHUB_ACTIONS_RUNNERS_PLUGIN_ID;
	readonly name = 'GitHub Actions runners';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'integration';
	readonly capabilities = ['actions-runners'] as const;
	readonly providerName = GITHUB_ACTIONS_RUNNERS_PLUGIN_ID;
	// `hybrid` since P2: the one setting is the person's own watched list (plan §7); there is
	// still no credential, no admin setting and nothing a person must fill in.
	readonly configurationMode = 'hybrid' as const;
	readonly settingsSchema: JsonSchema = githubActionsRunnersSettingsSchema;

	private readonly api: GitHubRunnersApi;

	/** `fetchImpl` / `base` are for tests; the platform constructs the plugin with no argument. */
	constructor(fetchImpl?: FetchLike, base?: string) {
		this.api = new GitHubRunnersApi(fetchImpl, base);
	}

	async onLoad(_context: PluginContext): Promise<void> {
		// Deliberately empty: no client, no socket, no timer before the first call.
	}

	async onUnload(): Promise<void> {
		// Nothing to release.
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		// Local only: without a token there is nothing to ask GitHub.
		return { status: 'healthy', message: 'ready', checkedAt: Date.now() };
	}

	listDownloads(target: ActionsRunnerTarget, token: string): Promise<ActionsRunnerDownload[]> {
		return this.api.listDownloads(target, token);
	}

	mintRegistrationToken(target: ActionsRunnerTarget, token: string): Promise<ActionsRunnerOneTimeToken> {
		return this.api.mintRegistrationToken(target, token);
	}

	mintRemoveToken(target: ActionsRunnerTarget, token: string): Promise<ActionsRunnerOneTimeToken> {
		return this.api.mintRemoveToken(target, token);
	}

	listRunners(target: ActionsRunnerTarget, token: string, options?: { etag?: string | null }): Promise<ActionsRunnersPage> {
		return this.api.listRunners(target, token, options);
	}

	deleteRunner(target: ActionsRunnerTarget, runnerId: number, token: string): Promise<void> {
		return this.api.deleteRunner(target, runnerId, token);
	}

	listJobs(
		target: ActionsRunnerTarget,
		token: string,
		options?: { etag?: string | null; repositories?: readonly string[] }
	): Promise<ActionsJobsPage> {
		return this.api.listJobs(target, token, options);
	}

	cancelRun(repository: string, runId: number, token: string): Promise<void> {
		return this.api.cancelRun(repository, runId, token);
	}

	async checkPermission(target: ActionsRunnerTarget, token: string): Promise<ActionsRunnersPermissionCheck> {
		if (await this.api.canManage(target, token)) return { ok: true };
		return { ok: false, missing: target.scope === 'org' ? ORG_RUNNERS_PERMISSION : REPO_RUNNERS_PERMISSION };
	}
}
