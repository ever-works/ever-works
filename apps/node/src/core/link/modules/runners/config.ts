import { join } from 'node:path';
import { isFleetActionsRunnerLabel, isFleetActionsRunnerName } from '@ever-works/contracts';
import { firstOutputLine, RunnerHostError, type RunnerExec, type RunnerExecResult } from './host';

/**
 * Actions runners on computers (FL-18, plan §6.1 `runner-config.ts`, spec
 * FR-7, FR-8, FR-9) — configure (register) and deregister a runner with its
 * own `config.sh` / `config.cmd`, unattended.
 *
 * The one-time token is given to the runner ONLY through its
 * environment-variable input (`ACTIONS_RUNNER_INPUT_TOKEN`), in the child's
 * environment and nowhere else: never an argument, never a file, never a log.
 * {@link runnerConfigArgs} has no token parameter at all, so no caller can put
 * it on a command line. A runner that does not honour the environment input
 * would stop at a prompt; `--unattended` makes it fail instead, and the node
 * reports that rather than falling back to an argument.
 *
 * `--replace` is passed only when the platform said GitHub already lists this
 * name as THIS runner (U10); `--runasservice` on Windows, where the runner
 * registers its own service and no other mode is offered (FR-9).
 */

/** The environment variable the runner reads its `--token` from (its `ACTIONS_RUNNER_INPUT_<NAME>` convention). */
export const RUNNER_TOKEN_ENV = 'ACTIONS_RUNNER_INPUT_TOKEN';

const CONFIG_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunnerConfigInput {
	platform: string;
	url: string;
	name: string;
	labels: readonly string[];
	replace: boolean;
}

/** The script that configures a runner in its folder. */
export function runnerConfigScript(platform: string, dir: string): string {
	return join(dir, platform === 'win32' ? 'config.cmd' : 'config.sh');
}

/**
 * How to start one of the runner's own scripts with argv only. Windows cannot
 * start a `.cmd` without a shell, so it runs through `cmd.exe /d /c` with the
 * script named relative to the runner's folder (the working folder) — no path
 * with spaces on the command line, and the names, URL and labels are already
 * restricted to characters `cmd` does not interpret.
 */
export function runnerScriptCommand(
	platform: string,
	dir: string,
	script: 'config' | 'svc',
	args: readonly string[],
	env: NodeJS.ProcessEnv = process.env
): { command: string; args: string[] } {
	if (platform === 'win32') {
		return { command: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/c', `${script}.cmd`, ...args] };
	}
	return { command: join(dir, `${script}.sh`), args: [...args] };
}

/** `config` argv for a registration — never a token (spec FR-7). */
export function runnerConfigArgs(input: RunnerConfigInput): string[] {
	if (!isFleetActionsRunnerName(input.name)) throw new RunnerHostError('not a runner name', 'invalid');
	if (!/^https:\/\/github\.com\/[A-Za-z0-9._/-]+$/.test(input.url))
		throw new RunnerHostError('not a GitHub URL', 'invalid');
	const labels = input.labels.filter((label) => isFleetActionsRunnerLabel(label));
	const args = ['--unattended', '--url', input.url, '--name', input.name, '--work', '_work'];
	if (labels.length > 0) args.push('--labels', labels.join(','));
	if (input.replace) args.push('--replace');
	if (input.platform === 'win32') args.push('--runasservice');
	return args;
}

/** `config remove` argv — the remove token rides the environment too. */
export function runnerRemoveArgs(): string[] {
	return ['remove', '--unattended'];
}

/** True when a `config` failure says the runner build did not read the token from the environment. */
export function looksLikeMissingTokenInput(result: Pick<RunnerExecResult, 'stdout' | 'stderr'>): boolean {
	return /(enter|missing|required).{0,40}token|--token/i.test(`${result.stdout}\n${result.stderr}`);
}

/** Run `config` to register the runner; the token travels in the child's environment only. */
export async function configureRunner(
	exec: RunnerExec,
	dir: string,
	input: RunnerConfigInput,
	token: string
): Promise<void> {
	const { command, args } = runnerScriptCommand(input.platform, dir, 'config', runnerConfigArgs(input));
	const result = await exec({
		command,
		args,
		cwd: dir,
		env: { [RUNNER_TOKEN_ENV]: token, RUNNER_ALLOW_RUNASROOT: '1' },
		timeoutMs: CONFIG_TIMEOUT_MS
	});
	if (result.spawnError)
		throw new RunnerHostError('the runner could not be started to register; nothing was registered');
	if (result.timedOut) throw new RunnerHostError('registering the runner took too long');
	if (result.code !== 0) {
		if (looksLikeMissingTokenInput(result)) {
			throw new RunnerHostError(
				'this runner build did not read its token from the environment; Ever Works never passes it on the command line, so nothing was registered'
			);
		}
		throw new RunnerHostError(`GitHub did not register the runner: ${firstOutputLine(result, 'config failed')}`);
	}
}

/** Run `config remove` with the remove token (environment only). */
export async function deregisterRunner(
	exec: RunnerExec,
	platform: string,
	dir: string,
	token: string
): Promise<boolean> {
	const { command, args } = runnerScriptCommand(platform, dir, 'config', runnerRemoveArgs());
	const result = await exec({
		command,
		args,
		cwd: dir,
		env: { [RUNNER_TOKEN_ENV]: token, RUNNER_ALLOW_RUNASROOT: '1' },
		timeoutMs: CONFIG_TIMEOUT_MS
	});
	return !result.spawnError && result.code === 0;
}
