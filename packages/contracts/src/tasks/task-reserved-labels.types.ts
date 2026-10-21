/**
 * Works-security (2026-10-18) — RESERVED Task labels.
 *
 * Task labels are free-form, but a few of them are CONTROL SIGNALS the
 * platform reads to decide what happens next without a person:
 *
 *  - `awaiting-owner` — BINDING hold on a Task filed from an untrusted email
 *    sender: no agent may move it, the fan-out never picks it up, only a person
 *    starting it clears it (`packages/agent/src/tasks-domain/awaiting-owner.ts`).
 *  - `app-provision` — marks an APW-04 provisioning Task; the provisioner's
 *    idempotency and the feedback loop find the Task by it. (The App change
 *    guard's exemption no longer reads it — that is `Task.origin` now.)
 *  - `provision-attempt-<n>` — the provisioning feedback loop's iteration
 *    counter; stripping it resets the loop's cap.
 *  - `release:promotion`, `release:revert` and their `:<rung>` variants — the
 *    merge gate reads them to force a recorded human approval and to resolve
 *    the branch a revert lands on (`packages/contracts/src/release/*`).
 *
 * A machine principal (a fleet-run token, an integration key) or an agent tool
 * — anything prompt injection can steer — must not add or remove them: one
 * injected run could release a held Task, reset a retry cap, or drop the label
 * that forces a person to approve a production revert. A person in the app
 * keeps full control. Enforced by `TasksService` (API + agent), the
 * integrations Task routes and the MCP `create_task` / `update_task` tools,
 * behind `TASK_RESERVED_LABELS_ENFORCED` (default on).
 */

/** Exact reserved labels (compared case-insensitively, trimmed). */
export const TASK_RESERVED_LABELS: readonly string[] = Object.freeze([
	'awaiting-owner',
	'app-provision',
	'release:promotion',
	'release:revert'
]);

/** Reserved label FAMILIES: any label starting with one of these is reserved. */
// `fleet:` (FL-13 P2): an Agent-session schedule's labels decide that a fire starts as an Agent session on a computer
// (`fleet:session-schedule`, `fleet:provider:…`, `fleet:checkout:…`) — only the platform's Schedules dialog writes them.
export const TASK_RESERVED_LABEL_PREFIXES: readonly string[] = Object.freeze(['release:', 'provision-attempt-', 'fleet:']);

/** The env switch that turns enforcement off (`false`); on when absent. */
export const TASK_RESERVED_LABELS_ENFORCED_ENV = 'TASK_RESERVED_LABELS_ENFORCED';

/**
 * Is `label` reserved? Compared on the trimmed, lower-cased text, so a
 * look-alike spelling (`Awaiting-Owner`, ` app-provision`) is refused too —
 * stricter than the readers, which match exactly, and never looser.
 */
export function isReservedTaskLabel(label: unknown): boolean {
	if (typeof label !== 'string') return false;
	const text = label.trim().toLowerCase();
	if (!text) return false;
	if (TASK_RESERVED_LABELS.includes(text)) return true;
	return TASK_RESERVED_LABEL_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** What a label write would change among the reserved labels. */
export interface ReservedTaskLabelChange {
	/** Reserved labels in `after` that `before` does not carry. */
	readonly added: readonly string[];
	/** Reserved labels in `before` that `after` no longer carries. */
	readonly removed: readonly string[];
}

/**
 * The reserved labels a write from `before` to `after` would add or remove.
 * Order and non-reserved labels are ignored. `after === undefined` means the
 * write does not touch labels at all (no change); `null` clears them.
 */
export function reservedTaskLabelChanges(
	before: readonly string[] | null | undefined,
	after: readonly string[] | null | undefined
): ReservedTaskLabelChange {
	if (after === undefined) return { added: [], removed: [] };
	const was = reservedOf(before);
	const now = reservedOf(after);
	return {
		added: [...now].filter((label) => !was.has(label)),
		removed: [...was].filter((label) => !now.has(label))
	};
}

/** `true` when {@link reservedTaskLabelChanges} reports anything. */
export function changesReservedTaskLabels(
	before: readonly string[] | null | undefined,
	after: readonly string[] | null | undefined
): boolean {
	const change = reservedTaskLabelChanges(before, after);
	return change.added.length > 0 || change.removed.length > 0;
}

/**
 * Parse {@link TASK_RESERVED_LABELS_ENFORCED_ENV}. Default-safe: anything but
 * an explicit `false` / `0` / `off` / `no` keeps enforcement ON.
 */
export function taskReservedLabelsEnforced(raw: string | null | undefined): boolean {
	const value = (raw ?? '').trim().toLowerCase();
	return !(value === 'false' || value === '0' || value === 'off' || value === 'no');
}

/** The sentence every refusal shares, so the API, the agent and MCP say the same thing. */
export function reservedTaskLabelRefusal(who: string, change: ReservedTaskLabelChange): string {
	const parts: string[] = [];
	if (change.added.length > 0) parts.push(`add ${change.added.map((l) => `"${l}"`).join(', ')}`);
	if (change.removed.length > 0) parts.push(`remove ${change.removed.map((l) => `"${l}"`).join(', ')}`);
	return (
		`${who} cannot ${parts.join(' or ')}: those Task labels are platform-controlled signals ` +
		'(holds, approvals, retry caps). Keep them exactly as they are; a person changes them in the app.'
	);
}

/**
 * The reserved labels of a list, by their EXACT text. Recognising a reserved
 * label is case- and whitespace-insensitive ({@link isReservedTaskLabel}), but
 * the comparison must not be: the readers match exactly (`awaiting-owner.ts`
 * looks for `'awaiting-owner'`), so swapping `awaiting-owner` for
 * `AWAITING-OWNER` releases the hold while a normalised comparison would call it
 * "no change". Exact text reports that swap as one removal plus one addition.
 */
function reservedOf(labels: readonly string[] | null | undefined): Set<string> {
	const out = new Set<string>();
	for (const label of labels ?? []) {
		if (isReservedTaskLabel(label)) out.add(label);
	}
	return out;
}
