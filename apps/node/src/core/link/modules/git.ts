import { makeFleetLinkError } from '@ever-works/contracts';
import type { CommandRunner } from '../../capabilities';
import { GitIdentityError, readGitIdentity, setGitIdentity } from './git/git-identity';
import { createMachineCommandRunner } from './machine-facts/exec';
import { MachineVerbError, type MachineVerbContext, type NodeModule } from './registry';

/**
 * Tasks on computers (FL-15 P2, CONTRACTS §3.3, R-40) — the `git` node module:
 * two `machine` verbs over this machine's GLOBAL git configuration.
 *
 *  - `git.identity` — reads `user.name`, `user.email` and whether a
 *    credential helper is configured (`git config --global --get`);
 *  - `git.setIdentity` — writes exactly `user.name` and `user.email`, and
 *    only those (spec FR-14, FR-15). The platform has already checked the
 *    person's `commands` audience and the `confirm` class (CONTRACTS §2.1,
 *    §2.2) before it asks.
 *
 * Both need `--manage` (the contracts consent table: `machine` verbs default
 * to `manage`), so a `--work`-only machine refuses them `consent_missing`.
 * `git.setIdentity` is state-changing: the machine family refuses it while
 * the kill switch has the link paused (CONTRACTS §3.2).
 */

export interface GitModuleOptions {
	runner?: CommandRunner;
}

export function createGitModule(options: GitModuleOptions = {}): NodeModule {
	const runner = options.runner ?? createMachineCommandRunner();

	const identity = async (context: MachineVerbContext) => {
		const facts = await readGitIdentity(runner);
		if (facts.gitMissing) {
			throw new MachineVerbError(
				makeFleetLinkError('unsupported_on_node', `git is not installed on ${context.nodeName}`, {
					missing: 'git'
				})
			);
		}
		return { name: facts.name, email: facts.email, helper: facts.helper, readAt: new Date().toISOString() };
	};

	const setIdentity = async (context: MachineVerbContext) => {
		try {
			const { fields } = await setGitIdentity(runner, { name: context.params.name, email: context.params.email });
			context.logger?.info(`git: global identity set (${fields.join(', ')})`);
			const facts = await readGitIdentity(runner);
			return {
				fields,
				name: facts.name,
				email: facts.email,
				helper: facts.helper,
				readAt: new Date().toISOString()
			};
		} catch (error) {
			if (error instanceof GitIdentityError) {
				throw new MachineVerbError(
					makeFleetLinkError(error.kind === 'invalid' ? 'invalid' : 'operation_failed', error.message)
				);
			}
			throw error;
		}
	};

	return {
		id: 'git',
		machineVerbs: {
			'git.identity': { stateChanging: false, run: identity },
			'git.setIdentity': { stateChanging: true, run: setIdentity }
		}
	};
}
