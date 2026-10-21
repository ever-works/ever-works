import {
	fleetConsentMissingHint,
	makeFleetLinkError,
	parseFleetScheduleRunNowParams,
	parseFleetScheduleRunsParams,
	parseFleetScheduleSyncParams,
	type FleetConsents,
	type FleetLinkError,
	type FleetScheduleDefinition,
	type FleetScheduleSyncResult
} from '@ever-works/contracts';
import type { Logger } from '../../logger';
import { resolveCommandFolder } from './command/command-folder';
import type { CommandOutputStore } from './command/command-output-store';
import type { NodeChannelContext, NodeChannelHandler, NodeLinkControlState, NodeModule } from './registry';
import { ScheduleHistory } from './schedule/schedule-history';
import { ScheduleLoop, type ScheduleLoopOptions } from './schedule/schedule-loop';
import { ScheduleStore } from './schedule/schedule-store';

/**
 * Fleet node link — the `schedule` family (FL-13, CONTRACTS §3.3, §6, R-24,
 * R-40): the node's half of Schedules on computers.
 *
 * The platform opens a short-lived channel per request:
 *
 *  - `schedule.sync { generation, definitions[] }` — hold EXACTLY this set
 *    (FR-11): each definition is checked (its folder must be home or a folder
 *    the machine's owner allowed — refused ones are listed, never held),
 *    written to `<configDir>/schedules/`, and the timer re-armed. The reply
 *    carries the applied generation, the held ids, the refusals, each
 *    schedule's next fire on this clock and this machine's zone.
 *  - `schedule.runs { since }` — the runs that ended since (and the ones
 *    running), with their first and last 64 KiB (FR-15).
 *  - `schedule.runNow { id, runId }` — run one now, under the platform's run
 *    id; `busy` while one runs (FR-19).
 *
 * The loop itself ({@link ScheduleLoop}) runs whether or not the link is up
 * (FR-12). Consent, on this machine: `--manage`, checked here too. Kill
 * switch (`link.pause`): the loop stops and every run ends `kill-switch`;
 * `link.resume` re-arms it. Drain: every run ends `drain`.
 */

export interface ScheduleModuleOptions extends Omit<ScheduleLoopOptions, 'store' | 'history'> {
	consents: FleetConsents;
	/** `<configDir>/schedules` — definitions, their clock state, runs and outputs. */
	dir: string;
	logger?: Logger;
}

export interface ScheduleModule extends NodeModule {
	readonly loop: ScheduleLoop;
	/** The ring keeping one run's full output (for `command.read`), or null. */
	findOutputStore(runId: string): Promise<CommandOutputStore | null>;
	/** Load the held set and start the timer (with or without a link). */
	start(): Promise<void>;
	/** Follow the link's kill switch and drain (`link.pause` / `link.resume` / `link.drain`). */
	bindLink(link: ScheduleModuleLink): void;
	dispose(): void;
}

type Reply = { result: unknown } | { error: FleetLinkError };

/** Just enough of the node link (`NodeLink`) for the module. */
export interface ScheduleModuleLink {
	readonly control: NodeLinkControlState;
	onChange?(listener: (state: { phase: string; linkGeneration: number | null }) => void): () => void;
}

/**
 * After a link becomes ready, how long a kill switch remembered from before
 * is honoured while the platform has a chance to re-send a pause in force
 * (it does right after `link.ready`); then the loop resumes.
 */
const RESUME_AFTER_READY_MS = 5_000;

/** The tag a node with schedules advertises (CONTRACTS §1.2). */
export const FLEET_SCHEDULES_CAPABILITY = 'schedules';

export function createScheduleModule(options: ScheduleModuleOptions): ScheduleModule {
	const store = new ScheduleStore({ dir: options.dir });
	const history = new ScheduleHistory({ dir: options.dir });
	const loop = new ScheduleLoop({ ...options, store, history });
	const unsubscribes: Array<() => void> = [];

	const zone = (): string | null => {
		try {
			return options.timeZone();
		} catch {
			return null;
		}
	};

	/** Split a set into what this machine holds and what it refuses (a folder it would never run in). */
	async function vet(
		definitions: readonly FleetScheduleDefinition[]
	): Promise<{ held: FleetScheduleDefinition[]; refused: FleetScheduleSyncResult['refused'] }> {
		const held: FleetScheduleDefinition[] = [];
		const refused: FleetScheduleSyncResult['refused'] = [];
		for (const definition of definitions) {
			const folder = await resolveCommandFolder({
				...(definition.cwd ? { cwd: definition.cwd } : {}),
				homedir: options.homedir,
				platform: options.platform,
				...(options.extraRoots ? { extraRoots: options.extraRoots } : {}),
				nodeName: options.nodeName,
				...(options.realpath ? { realpath: options.realpath } : {})
			});
			if (folder.error) {
				refused.push({ id: definition.id, error: makeFleetLinkError('invalid', folder.error.hint, { field: 'cwd' }) });
			} else {
				held.push(definition);
			}
		}
		return { held, refused };
	}

	function openChannel(context: NodeChannelContext): NodeChannelHandler {
		let closed = false;
		const reply = (requestId: unknown, outcome: Reply) => {
			if (closed || typeof requestId !== 'string') return;
			context.sendJson({ requestId, ...outcome });
		};

		async function handle(verb: unknown, requestId: unknown, params: Record<string, unknown>): Promise<void> {
			if (verb === 'schedule.sync') {
				const parsed = parseFleetScheduleSyncParams(params);
				if (!parsed) {
					reply(requestId, { error: makeFleetLinkError('invalid', 'schedule set') });
					return;
				}
				const { held, refused } = await vet(parsed.params.definitions);
				for (const id of parsed.unreadable) {
					refused.push({
						id,
						error: makeFleetLinkError('unsupported_on_node', `update the node on ${options.nodeName} to run this schedule`)
					});
				}
				await loop.replace(held, parsed.params.generation);
				reply(requestId, {
					result: {
						generation: parsed.params.generation,
						held: loop.held(),
						refused,
						next: loop.nextFires(),
						timeZone: zone()
					} satisfies FleetScheduleSyncResult
				});
				return;
			}
			if (verb === 'schedule.runs') {
				const { since } = parseFleetScheduleRunsParams(params);
				const page = await history.since(since);
				reply(requestId, { result: { runs: page.runs, more: page.more, timeZone: zone() } });
				return;
			}
			if (verb === 'schedule.runNow') {
				const parsed = parseFleetScheduleRunNowParams(params);
				if (!parsed) {
					reply(requestId, { error: makeFleetLinkError('invalid', 'run-now parameters') });
					return;
				}
				const outcome = await loop.runNow(parsed.id, parsed.runId);
				reply(requestId, 'error' in outcome ? { error: outcome.error } : { result: outcome });
				return;
			}
			reply(requestId, { error: makeFleetLinkError('invalid', 'unknown schedule request') });
		}

		return {
			onJson(message) {
				const params =
					typeof message.params === 'object' && message.params !== null && !Array.isArray(message.params)
						? (message.params as Record<string, unknown>)
						: {};
				void handle(message.type, message.requestId, params).catch((error: unknown) => {
					options.logger?.warn(`Schedules: a request failed: ${error instanceof Error ? error.message : String(error)}`);
					reply(message.requestId, { error: makeFleetLinkError('operation_failed', 'the schedule request failed') });
				});
			},
			onClose() {
				closed = true;
			}
		};
	}

	return {
		id: 'schedule',
		loop,
		findOutputStore: (runId) => history.storeFor(runId),
		tags: (environment) => (environment.consents.manage ? [FLEET_SCHEDULES_CAPABILITY] : []),
		families: [
			{
				family: 'schedule',
				consent: 'manage',
				open(context) {
					if (!options.consents.manage) {
						return {
							ok: false,
							error: makeFleetLinkError('consent_missing', fleetConsentMissingHint('manage', options.nodeName))
						};
					}
					return { ok: true, handler: openChannel(context) };
				}
			}
		],
		start: () => loop.start(),
		bindLink(link) {
			for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
			let lastDrain = link.control.drain?.receivedAt ?? null;
			let lastGeneration: number | null = null;
			let resumeTimer: ReturnType<typeof setTimeout> | null = null;
			// A pause in force when we bind.
			if (link.control.paused) void loop.pause();
			unsubscribes.push(
				link.control.onChange((state) => {
					if (state.paused) void loop.pause();
					else void loop.resume();
					if (state.drain && state.drain.receivedAt !== lastDrain) {
						lastDrain = state.drain.receivedAt;
						loop.drain();
					}
				})
			);
			// A pause remembered from a previous process (spec §8b) ends when a
			// ready link has said nothing about the kill switch for a moment:
			// the platform re-sends a pause in force right after `link.ready`.
			if (link.onChange) {
				unsubscribes.push(
					link.onChange((state) => {
						if (state.phase !== 'connected' || state.linkGeneration === lastGeneration) return;
						lastGeneration = state.linkGeneration;
						if (resumeTimer) clearTimeout(resumeTimer);
						resumeTimer = setTimeout(() => {
							resumeTimer = null;
							if (!link.control.paused && loop.isPaused) void loop.resume();
						}, RESUME_AFTER_READY_MS);
						resumeTimer.unref?.();
					}),
					() => {
						if (resumeTimer) clearTimeout(resumeTimer);
						resumeTimer = null;
					}
				);
			}
		},
		dispose() {
			for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
			loop.dispose();
		}
	};
}
