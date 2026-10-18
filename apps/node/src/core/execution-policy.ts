import type { FleetAgentModelExecution } from '@ever-works/contracts';
import type { NodeExecutionPolicy } from './types';

/**
 * Control 18 (2026-10-18) — the machine owner's local ceiling on what a
 * platform job may make this PC do.
 *
 * A job is the platform's plan, and the platform is one more party that a
 * prompt injection, a compromised account, a leaked API key or a plain bug
 * can speak through. Two things a job can ask for turn "a model edits a
 * worktree" into "anything runs as the machine owner":
 *
 *   - **skip-permissions** — `--dangerously-skip-permissions` /
 *     `--dangerously-bypass-approvals-and-sandbox` hand the model an
 *     unrestricted shell on a machine with no filesystem or egress boundary
 *     (trust model gaps 12–13);
 *   - **shell commands** — the setup phase, command steps, acceptance checks,
 *     the legacy command template and `acceptance-checks` jobs are shell
 *     strings the node runs itself. They execute repository code, and after
 *     a model step that is code the model may just have written: an edited
 *     `package.json` script or test file makes `pnpm test` run it, outside
 *     every permission mode the model was held to.
 *
 * Both are therefore decided HERE, by `ever-works-node policy` on the
 * machine, and both default to OFF. The platform can ask; it cannot flip
 * them. A refused job fails before anything is provisioned or spawned, with
 * a message that says exactly which switch the owner would have to turn on.
 */
export class NodeExecutionPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NodeExecutionPolicyError';
	}
}

/** How to change the policy, quoted in every refusal so the owner is never left guessing. */
export const NODE_POLICY_COMMAND_HINT =
	'The machine owner can allow it on this PC with `ever-works-node policy <flag> on` (then restart the node; for the ' +
	'desktop app, run the command with EVER_WORKS_NODE_CONFIG set to the app’s node-config.json); the platform cannot ' +
	'change this setting';

/** One sentence naming a command phase and how many commands it carries. */
function describePhase(name: string, count: number): string | null {
	return count > 0 ? `${count} ${name}${count === 1 ? '' : 's'}` : null;
}

/**
 * Refuse an `agent-task` this machine's policy does not admit.
 *
 * `policy` absent means "the embedder did not ask for a policy" (a direct
 * library caller or a spec): nothing is enforced, exactly as before this
 * control existed. The node's own runtime ALWAYS passes the stored policy
 * (OFF/OFF unless the owner changed it), so the real binary never takes that
 * branch.
 */
export function enforceAgentTaskExecutionPolicy(
	input: {
		execution: Pick<FleetAgentModelExecution, 'provider' | 'skipPermissions'> | null;
		setupCount: number;
		stepCount: number;
		checkCount: number;
	},
	policy: NodeExecutionPolicy | undefined
): void {
	if (!policy) return;
	if (input.execution?.skipPermissions === true && !policy.allowSkipPermissions) {
		throw new NodeExecutionPolicyError(
			`Refused by this node's local execution policy: the job asks to run ${String(input.execution.provider)} ` +
				'with its permission checks switched off (skip-permissions), which gives an untrusted prompt an ' +
				`unrestricted shell as the machine owner. ${NODE_POLICY_COMMAND_HINT} (flag: --allow-skip-permissions).`
		);
	}
	if (policy.allowShellCommands) return;
	const phases = [
		describePhase('setup command', input.setupCount),
		describePhase(input.execution ? 'command step' : 'command-template step', input.stepCount),
		describePhase('acceptance check', input.checkCount)
	].filter((phase): phase is string => phase !== null);
	if (phases.length === 0) return;
	throw new NodeExecutionPolicyError(
		`Refused by this node's local execution policy: the job carries ${phases.join(', ')}. Those are shell ` +
			'commands the node itself would run with the machine owner’s privileges, executing repository code' +
			(input.execution ? ' — after the model step, code the model may have just written' : '') +
			`. ${NODE_POLICY_COMMAND_HINT} (flag: --allow-shell-commands), or run this Work with checks off.`
	);
}

/** Refuse an `acceptance-checks` job this machine's policy does not admit (same contract as above). */
export function enforceAcceptanceChecksExecutionPolicy(
	checkCount: number,
	policy: NodeExecutionPolicy | undefined
): void {
	if (!policy || policy.allowShellCommands || checkCount === 0) return;
	throw new NodeExecutionPolicyError(
		`Refused by this node's local execution policy: the job carries ${describePhase('acceptance check', checkCount)}, ` +
			'shell commands the node would run with the machine owner’s privileges. ' +
			`${NODE_POLICY_COMMAND_HINT} (flag: --allow-shell-commands).`
	);
}
