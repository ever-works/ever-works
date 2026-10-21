import {
	checkoutHardeningEnv,
	emptyHooksDir,
	execFileWithVerifiedCancellation,
	FILTER_DRIVER_PROBE_ARGS,
	parseFilterDriverConfig
} from '@ever-works/local-workspace-plugin';

/**
 * works-security (node 0.2.7, control 21 follow-up) — the dirty checks the
 * node's workspace housekeeping runs over a fleet worktree.
 *
 * The inventory (`ever-works-node workspaces`, the reaper's scan) and the
 * reaper's last-moment re-check ran a plain `git status` in every owned
 * worktree, i.e. with the repository's Git behaviour: an fsmonitor command,
 * a filter driver's `clean` (Git runs it to hash a file whose stat data no
 * longer matches the index) and, for a POPULATED submodule, a child
 * `git status` inside it that reads that submodule's own `.git` — a
 * directory the model can write, whose config the node's overlay does not
 * see. Control 21 hardened provisioning, the mount reset and the finalize;
 * these two ran on the heartbeat's schedule, as the machine owner, with
 * none of it.
 *
 * Now both run with the checkout-hardening overlay (hooks → an empty dir,
 * `core.fsmonitor=false`, every visible filter driver and `lfs` emptied,
 * `submodule.recurse=false`) and `--ignore-submodules=dirty`: a submodule
 * still counts when its recorded COMMIT moved, but Git no longer starts a
 * process inside its work tree. Provisioning never populates a submodule
 * (`submodule.recurse=false`), so a populated one was made by the run, and
 * the node never commits inside one either.
 *
 * Every deviation lands on the SAFE side for the reaper: a file whose clean
 * filter no longer runs reads as modified, so the worktree is kept, never
 * reaped; an overlay that cannot be computed makes the state `unknown`,
 * which the reaper also keeps.
 */
export const HARDENED_DIRTY_STATUS_ARGS: readonly string[] = [
	'status',
	'--porcelain',
	'--untracked-files=all',
	'--ignore-submodules=dirty'
];

/**
 * The overlay for {@link HARDENED_DIRTY_STATUS_ARGS} in `repoPath`: the
 * filter drivers visible from there are read first (`git config` runs no
 * hook or filter), then all of them are neutralised along with hooks and
 * fsmonitor. Throws when the empty hooks directory cannot be created; the
 * callers turn that into `unknown`.
 */
export async function statusHardeningEnv(repoPath: string, signal?: AbortSignal): Promise<Record<string, string>> {
	const probe = await execFileWithVerifiedCancellation('git', [...FILTER_DRIVER_PROBE_ARGS], {
		cwd: repoPath,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		windowsHide: true,
		maxBuffer: 1024 * 1024,
		...(signal ? { signal } : {})
	});
	// Exit 1 is "no filter driver configured" — the healthy answer.
	const found = probe.error ? [] : parseFilterDriverConfig(String(probe.stdout ?? ''));
	return checkoutHardeningEnv(await emptyHooksDir(), found);
}
