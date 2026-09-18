import type {
	BuildAuth,
	BuildRef,
	BuildSnapshot,
	BuildStrategy,
	IBuildPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginManifest,
	PrepareRepositoryInput,
	PrepareRepositoryResult,
	RepositoryWriter,
	StartBuildInput
} from '@ever-works/plugin';
import type { AppBuildKind } from '@ever-works/contracts';

import { gitHubActionsBuildSettingsSchema, type GitHubActionsBuildSettings } from './settings.schema.js';

/**
 * APW-05 T7 — the `github-actions-build` plugin: the identity the platform's
 * discovery path and the `build` capability need, the settings of plan §4.4, and
 * the members T8–T10 have not reached yet.
 *
 * What exists here:
 *
 *   - the manifest the `everworks.plugin` block in `package.json` also declares
 *     (they must agree — `plugin-manifest-validator.service.ts` extracts the
 *     block from disk and `plugin-class-validator.service.ts` compares the loaded
 *     class against it);
 *   - `settingsSchema` — plan §4.4, with `pullToken` `x-secret` and both
 *     platform-managed markers (`APW05-G07`);
 *   - the two lifecycle hooks the loader calls. Both are **prototype methods on
 *     purpose**: `PluginClassValidatorService.isPluginClass` accepts a class only
 *     when `onLoad` and `onUnload` sit on its prototype, so an arrow-function
 *     property would make this plugin undiscoverable.
 *
 * ## Why every `IBuildPlugin` member below throws (Constitution VI, Rule: a
 * ## capability a plugin claims, it implements — no member pretends)
 *
 * The five required members are declared because `IBuildPlugin` requires them,
 * and each throws {@link notImplemented} naming the task that fills it. None of
 * them answers a caller: there is no stub that would "succeed" at preparing a
 * repository, dispatching a run, observing one, cancelling it or producing a logs
 * URL before the code that does that exists.
 *
 * The composition each one waits on, precisely:
 *
 * | Member                | Already landed in this slice                     | Still missing, and where it lands              |
 * | --------------------- | ------------------------------------------------ | ---------------------------------------------- |
 * | `prepareRepository`   | T8 generator, T9 writer, T10 secret sync         | T11 runner selector (the `runs-on` label and class the generator needs) and T41 (the `checks` job); T16 binds the `RepositoryWriter` and T19 calls it |
 * | `startBuild`          | the generated file's `workflow_dispatch` inputs  | T12 (dispatch on the tracked branch, the 404/422 retry after a bootstrap commit) |
 * | `getBuild`            | —                                                | T12 (`run-observer`), T43 fills `verification` |
 * | `cancelBuild`         | —                                                | T12 (cancel endpoint)                          |
 * | `getLogsUrl`          | —                                                | T12                                            |
 *
 * `listRecentRuns?` (T12) and `checkImageAccess?` (T14) are deliberately **not
 * declared**: both are optional on the contract and a caller materialises the
 * member before calling it, so declaring a throwing placeholder would buy
 * nothing and would tell a future reader the capability is wired when it is not.
 */
export class GitHubActionsBuildPlugin implements IBuildPlugin {
	readonly id = 'github-actions-build';
	readonly name = 'GitHub Actions builds';
	readonly version = '1.0.0';

	/**
	 * Plan §4.3: the `build` category — appended to `PLUGIN_CATEGORIES` by APW-05
	 * T3 (`packages/plugin/src/contracts/plugin-manifest.types.ts`), so the
	 * loader's own `isPluginCategory` gate accepts this manifest.
	 */
	readonly category: PluginCategory = 'build';

	/** Plan §4.3: exactly one capability. `isBuildPlugin` resolves this plugin on it. */
	readonly capabilities: readonly string[] = ['build'];

	/** Plan §4.3. `AppBuildKind` — a closed union in `@ever-works/contracts`. */
	readonly buildKind: AppBuildKind = 'github-actions';

	/**
	 * Plan §4.1/R-13: `dockerfile` only.
	 *
	 * `auto` is deliberately absent: the zero-config builder is a provider-internal
	 * choice this plugin does not have, so the strategy gate leaves that Build
	 * unstarted (`strategyNotSupported`) rather than half-built. `image` and `none`
	 * are absent for the same reason — they need no build at all, and the prepare
	 * runner handles them before a build plugin is asked (plan §7.2).
	 */
	readonly supportedStrategies: readonly BuildStrategy[] = ['dockerfile'];

	/** Work-scoped settings, like the other per-Work provider plugins. */
	readonly configurationMode = 'user-required';

	/** Plan §4.4, exactly. */
	readonly settingsSchema: JsonSchema = gitHubActionsBuildSettingsSchema;

	async onLoad(context: PluginContext): Promise<void> {
		// No resources to hold: the GitHub client is bound per call from the
		// facade's auth, and nothing here reaches the network.
		context.logger.log('GitHub Actions build plugin loaded');
	}

	async onUnload(): Promise<void> {
		// Symmetric with onLoad: nothing is held, so nothing is released.
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				"Builds the App Work's container image on GitHub-hosted runners, through the workflow Ever Works writes into the repository's tracked branch",
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			autoEnable: true,
			visibility: 'user-only'
		};
	}

	// IBuildPlugin -----------------------------------------------------------
	// Every member is declared and none pretends: see the class docstring for the
	// task each one waits on.

	async prepareRepository(
		_input: PrepareRepositoryInput,
		_auth: BuildAuth,
		_writer: RepositoryWriter
	): Promise<PrepareRepositoryResult> {
		throw notImplemented('prepareRepository', 'APW-05 T11 (runner selector) and T41 (checks job)');
	}

	async startBuild(
		_input: StartBuildInput,
		_auth: BuildAuth
	): Promise<{ providerRunId: string | null; dispatchedAt: string }> {
		throw notImplemented('startBuild', 'APW-05 T12');
	}

	async getBuild(_ref: BuildRef, _auth: BuildAuth, _redact: (text: string) => string): Promise<BuildSnapshot | null> {
		throw notImplemented('getBuild', 'APW-05 T12');
	}

	async cancelBuild(_ref: BuildRef, _auth: BuildAuth): Promise<void> {
		throw notImplemented('cancelBuild', 'APW-05 T12');
	}

	async getLogsUrl(_ref: BuildRef, _auth: BuildAuth): Promise<string | null> {
		throw notImplemented('getLogsUrl', 'APW-05 T12');
	}
}

/**
 * The error every unimplemented member throws.
 *
 * One shape and one message format, so a caller can tell "this plugin does not
 * do that yet" from a provider failure — and so the message names the task that
 * will make it true rather than a bare "not implemented".
 */
export function notImplemented(member: string, owner: string): Error {
	return new Error(`github-actions-build: ${member} is not implemented yet — ${owner} owns it.`);
}

/** The settings shape this plugin reads once resolved (plan §4.4). Re-exported for the facade's binding. */
export type { GitHubActionsBuildSettings };

export default GitHubActionsBuildPlugin;
