import {
	isFleetProcessPid,
	isFleetProcessSignal,
	isFleetServiceAction,
	isFleetServiceName,
	isFleetServiceScope,
	makeFleetLinkError,
	type FleetProcessSignal,
	type FleetServiceAction,
	type FleetServiceScope
} from '@ever-works/contracts';
import { MachineVerbError } from '../registry';

/**
 * Machine facts (FL-09, FR-36) — every name or number a request carries is
 * checked HERE, on the machine, against the strict contracts patterns before
 * it can reach a child process — whatever the platform already checked (the
 * node never trusts that it did). A refusal is the typed `invalid` naming the
 * field, and nothing runs.
 */

function invalid(field: string, hint: string): MachineVerbError {
	return new MachineVerbError(makeFleetLinkError('invalid', hint, { field }));
}

/** A service name a manager will be asked about (`nginx`, `com.openssh.sshd`, `W3SVC`). */
export function assertServiceName(value: unknown): string {
	if (!isFleetServiceName(value)) {
		throw invalid('name', 'that is not a service name Ever Works acts on');
	}
	return value;
}

export function assertServiceScope(value: unknown): FleetServiceScope {
	if (value === undefined || value === null) return 'system';
	if (!isFleetServiceScope(value)) throw invalid('scope', 'scope must be system or user');
	return value;
}

export function assertServiceAction(value: unknown): FleetServiceAction {
	if (!isFleetServiceAction(value)) throw invalid('action', 'action must be start, stop, restart, enable or disable');
	return value;
}

export function assertPid(value: unknown): number {
	if (!isFleetProcessPid(value)) throw invalid('pid', 'pid must be a positive whole number');
	return value;
}

export function assertSignal(value: unknown): FleetProcessSignal {
	if (!isFleetProcessSignal(value)) throw invalid('signal', 'signal must be TERM or KILL');
	return value;
}

/** True when no argv element could be read as an option or carries a control character. */
export function isSafeArgv(argv: readonly string[]): boolean {
	return argv.every((arg) => typeof arg === 'string' && !/[\0\r\n]/.test(arg));
}
