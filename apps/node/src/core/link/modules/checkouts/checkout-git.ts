import { execFileWithVerifiedCancellation } from '@ever-works/local-workspace-plugin';

/**
 * Checkouts on computers (FL-14) — the one way this module runs `git`.
 *
 * Every git shell-out goes through the cancellable exec the Task pool already
 * uses (`execFileWithVerifiedCancellation`), with:
 *
 *  - no prompt, ever (`GIT_TERMINAL_PROMPT=0`): a fetch on the owner's clone
 *    that would ask for a password fails instead of hanging the request;
 *  - `-c core.longpaths=true` on Windows, so a deep checkout is readable;
 *  - argv only — never a shell, never a string the platform composed.
 *
 * Injected as a {@link CheckoutGitRunner} so every spec runs without a real
 * `git` (and can assert the argv it would have run).
 */

export interface CheckoutGitResult {
	/** Exit code; `-1` when git could not be started (missing binary, timeout). */
	code: number;
	stdout: string;
	stderr: string;
}

export interface CheckoutGitRunOptions {
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Extra environment for this one command (never written anywhere). */
	env?: Readonly<Record<string, string>>;
}

export type CheckoutGitRunner = (args: readonly string[], options: CheckoutGitRunOptions) => Promise<CheckoutGitResult>;

/** Per-command bound on a local git read (status, diff, rev-list). */
export const CHECKOUT_GIT_LOCAL_TIMEOUT_MS = 15_000;

/** Per-command bound on a network git command (fetch, pull, push, clone). */
export const CHECKOUT_GIT_NETWORK_TIMEOUT_MS = 10 * 60_000;

/** The argv prefix every git command carries on this platform. */
export function checkoutGitPrefix(platform: string): string[] {
	return platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
}

/** The real runner: `git` on PATH, cancellable, bounded. */
export function createCheckoutGitRunner(platform: string = process.platform): CheckoutGitRunner {
	const prefix = checkoutGitPrefix(platform);
	return async (args, options) => {
		const signals: AbortSignal[] = [];
		if (options.signal) signals.push(options.signal);
		signals.push(AbortSignal.timeout(options.timeoutMs ?? CHECKOUT_GIT_LOCAL_TIMEOUT_MS));
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
		try {
			const { error, stdout, stderr } = await execFileWithVerifiedCancellation('git', [...prefix, ...args], {
				cwd: options.cwd,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.env ?? {}) },
				windowsHide: true,
				maxBuffer: 16 * 1024 * 1024,
				signal
			});
			const code =
				error && typeof (error as { code?: unknown }).code === 'number'
					? ((error as { code?: number }).code ?? 1)
					: error
						? 1
						: 0;
			return { code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
		} catch (error) {
			if (error instanceof Error && error.name === 'ProcessTreeTerminationError') throw error;
			if (options.signal?.aborted) throw error;
			return { code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
		}
	};
}

/**
 * The first line of git's stderr, safe to send: any URL userinfo removed
 * (git prints the remote it failed on, and an owner's remote may carry a
 * token), bounded to one sentence.
 */
export function redactedStderrHead(stderr: string, max = 300): string | null {
	for (const raw of stderr.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const redacted = line.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1');
		return redacted.slice(0, max);
	}
	return null;
}
