import {
	APP_BUILD_RUNNERS,
	APP_BUILD_RUNNER_HEADROOM_GIB,
	appBuildRunnerCapacity,
	type AppBuildRunnerClass
} from '@ever-works/contracts';
import type { GitHubActionsBuildSettings } from '../settings.schema.js';

/**
 * APW-05 T11 — which runner a Build runs on, and whether it fits.
 *
 * Plan §7.2 step 4 is the whole rule, and it is short enough to state here:
 * a **public** repository takes GitHub's standard hosted runner; a **private**
 * one takes the installation's configured larger runner when it has one, else
 * GitHub's private-repository runner; and a Build whose declared memory exceeds
 * the chosen runner's memory minus {@link APP_BUILD_RUNNER_HEADROOM_GIB} is
 * **blocked** rather than started.
 *
 * ## Why the headroom, and why blocking beats trying
 *
 * The two gibibytes are the runner's own overhead — the OS, the Actions agent,
 * the Docker daemon. A Build that declares more than what is left does not fail
 * with a message anybody can act on: it is OOM-killed somewhere inside
 * `docker build`, minutes in, with a log that says `Killed` and nothing else.
 * Refusing before the dispatch costs the member nothing and tells them the two
 * numbers they need — {@link RunnerTooSmall.needed} and
 * {@link RunnerTooSmall.max}.
 *
 * ## An ABSENT memory declaration never blocks (APW05-G14, FR-23)
 *
 * "No `build.resources.memory`" means *the runner's own maximum*, not zero and
 * not a default this file invents. It is the common case — most App specs
 * declare no resources at all — so treating it as a fit is the difference
 * between a working product and one that refuses every Build nobody tuned.
 *
 * ## CPU is a WARNING, never a block
 *
 * A Build that asks for more vCPU than the runner has still runs; it is simply
 * slower, because the kernel schedules it. Memory is different in kind: there is
 * no "slower" for memory, only a kill. So over-declared CPU is reported and the
 * Build proceeds — and the report exists so the member can see why their build
 * takes eleven minutes.
 */

/** Plan §7.2's block reason for a Build that cannot fit its runner. */
export const RUNNER_TOO_SMALL = 'runnerTooSmall' as const;

/** The runner a Build was placed on. */
export interface SelectedRunner {
	/** The `runs-on:` value the generated workflow carries. */
	readonly label: string;
	/** Which class it is, for the receipt and the usage record. */
	readonly runnerClass: AppBuildRunnerClass;
	readonly vcpu: number;
	readonly memoryGiB: number;
	/** The declared memory ceiling: the runner's memory minus the headroom. */
	readonly usableMemoryGiB: number;
	/**
	 * Set when the Build declares more vCPU than the runner has. The Build still
	 * runs — see the file docstring on why CPU is not a block.
	 */
	readonly cpuOverDeclared?: { readonly needed: number; readonly max: number };
}

/** Why a Build cannot run: it declares more memory than any available runner leaves it. */
export interface RunnerTooSmall {
	readonly reason: typeof RUNNER_TOO_SMALL;
	/** The memory the App spec declared, in GiB. */
	readonly needed: number;
	/** The most the chosen runner can give it, in GiB (runner memory − headroom). */
	readonly max: number;
}

/** What {@link selectRunner} answers. */
export type RunnerSelection =
	| { readonly ok: true; readonly runner: SelectedRunner }
	| { readonly ok: false; readonly blocked: RunnerTooSmall };

/** What the selection needs to know about the Build. */
export interface SelectRunnerInput {
	/** The repository's provider visibility, which picks the runner family. */
	readonly visibility: 'public' | 'private';
	/**
	 * `build.resources` from the App spec. **Absent means the runner's maximum**
	 * and never blocks (APW05-G14) — see the file docstring.
	 */
	readonly resources?: { readonly memoryGiB?: number | null; readonly vcpu?: number | null };
	/** The installation's settings, which may name a larger runner for private repositories. */
	readonly settings?: Pick<
		GitHubActionsBuildSettings,
		'largerRunnerLabel' | 'largerRunnerMemoryGiB' | 'largerRunnerVcpu'
	>;
}

/**
 * The larger runner an installation configured, if it configured a usable one.
 *
 * A label with no memory is NOT a runner: the settings schema already makes
 * `largerRunnerMemoryGiB` required when a label is set, and this is the runtime
 * half of that rule. Accepting a label without memory would mean selecting a
 * runner whose capacity is unknown and then comparing a declared memory against
 * `NaN`, which fits everything.
 */
function largerRunnerOf(input: SelectRunnerInput): SelectedRunner | null {
	const label = (input.settings?.largerRunnerLabel ?? '').trim();
	const memoryGiB = Number(input.settings?.largerRunnerMemoryGiB ?? 0);
	if (label.length === 0 || !Number.isFinite(memoryGiB) || memoryGiB <= 0) {
		return null;
	}
	const vcpu = Number(input.settings?.largerRunnerVcpu ?? 0);
	return {
		label,
		runnerClass: 'github-larger',
		vcpu: Number.isFinite(vcpu) && vcpu > 0 ? vcpu : 0,
		memoryGiB,
		usableMemoryGiB: memoryGiB - APP_BUILD_RUNNER_HEADROOM_GIB
	};
}

/** One of GitHub's two hosted runners, as a {@link SelectedRunner}. */
function hostedRunner(key: 'githubPublic' | 'githubPrivate'): SelectedRunner {
	const runner = APP_BUILD_RUNNERS[key];
	return {
		label: runner.label,
		runnerClass: runner.runnerClass as AppBuildRunnerClass,
		vcpu: runner.vcpu,
		memoryGiB: runner.memoryGiB,
		usableMemoryGiB: appBuildRunnerCapacity(runner).memoryGiB
	};
}

/**
 * Place a Build on a runner, or block it.
 *
 * The order is plan §7.2 step 4's: the repository's visibility picks the family,
 * a configured larger runner beats the private default, and the declared memory
 * is then checked against whatever was chosen. The comparison is **inclusive at
 * the limit** — a Build declaring exactly the usable memory fits, which is what
 * `appBuildRunnerFits` in contracts already says and what the two boundary cases
 * in the spec pin.
 */
export function selectRunner(input: SelectRunnerInput): RunnerSelection {
	const runner =
		input.visibility === 'public'
			? hostedRunner('githubPublic')
			: (largerRunnerOf(input) ?? hostedRunner('githubPrivate'));

	const declaredMemory = input.resources?.memoryGiB;
	// Absent (or nonsense) means "the runner's maximum" and never blocks.
	const needsMemory = typeof declaredMemory === 'number' && Number.isFinite(declaredMemory) && declaredMemory > 0;

	if (needsMemory && declaredMemory > runner.usableMemoryGiB) {
		return {
			ok: false,
			blocked: { reason: RUNNER_TOO_SMALL, needed: declaredMemory, max: runner.usableMemoryGiB }
		};
	}

	const declaredVcpu = input.resources?.vcpu;
	const overDeclaresCpu =
		typeof declaredVcpu === 'number' &&
		Number.isFinite(declaredVcpu) &&
		runner.vcpu > 0 &&
		declaredVcpu > runner.vcpu;

	return {
		ok: true,
		runner: overDeclaresCpu
			? { ...runner, cpuOverDeclared: { needed: declaredVcpu as number, max: runner.vcpu } }
			: runner
	};
}
