import {
	FLEET_SESSION_RULE_INTERVAL_MS,
	FLEET_SESSION_RULE_QUIET_MS,
	initialFleetSessionStatus,
	isFleetDaemonSessionId,
	isFleetSessionDecisionReason,
	makeFleetLinkError,
	mergeFleetSessionEvidence,
	type FleetLinkError,
	type FleetLinkExtensionMessage,
	type FleetSessionAnswerParams,
	type FleetSessionAttention,
	type FleetSessionAttentionMessage,
	type FleetSessionEvidence,
	type FleetSessionHooks,
	type FleetSessionKind,
	type FleetSessionProvider,
	type FleetSessionStatusMessage,
	type FleetSessionStatusSnapshot
} from '@ever-works/contracts';
import { systemScheduler, type Scheduler } from '../heartbeat';
import type { Logger } from '../logger';
import {
	drainHookSpool,
	materializeHookClient,
	writeHookEndpointFile,
	type HookFs,
	type HookPaths
} from './hook-client';
import { HookEndpoint, type HookEndpointEvent } from './hook-endpoint';
import { normalizeHookEvent } from './hook-events';
import type { SessionHookOverlay } from './hook-overlay';
import type { DaemonSessionInfo, DaemonWatchEvent } from './daemon/daemon-protocol';
import { keysForAnswer } from './answer-typist';
import { SessionRulesEngine } from './rules-engine';

/**
 * Session status (FL-05, plan §6.1 `evidence-merger.ts`, spec FR-1 … FR-19)
 * — the node's status pipeline: the loopback hook endpoint, its endpoint file
 * and client, the spool, and ONE merger per session over everything the node
 * sees about it:
 *
 *  - the CLI's hooks (posted to the endpoint, or drained from the spool), in
 *    the order they arrived;
 *  - the daemon's watch stream — output (`activity`), exit;
 *  - a driver's Ctrl-C in a running turn (`interrupt`, U15);
 *  - the clock — 30 minutes without evidence is `idle` (FR-14);
 *  - (P2) the screen rules and the answer typist, through {@link addEvidence}.
 *
 * Each merge runs the shared state machine (`mergeFleetSessionEvidence`,
 * contracts) and, when anything changed, reports on channel 0:
 * `session.status` (state, outcome, evidence, lines, hooks) and, when the
 * attention moved, `session.attention`. Reports carry a sequence that never
 * goes below this machine's clock, so the platform applies only newer ones
 * (U5) — also across a node restart. After every (re)connect of the link the
 * current status of every session that has reported is sent again, so a
 * report lost while the link was down is not lost.
 *
 * The status pipeline spends no model tokens (FR-51): it only reads what the
 * CLI and the daemon already say.
 */

/** Just what the pipeline needs of the session daemon supervisor. */
export interface SessionStatusDaemon {
	readonly healthy: boolean;
	request<T = unknown>(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
	onEvent(listener: (event: DaemonWatchEvent) => void): () => void;
	onConnected(listener: (client: unknown) => void): () => void;
}

/** Just what the pipeline needs of the link. */
export interface SessionStatusLink {
	getState(): { phase: string; linkGeneration: number | null };
	onChange(listener: (state: { phase: string; linkGeneration: number | null }) => void): () => void;
	sendControl(message: FleetLinkExtensionMessage): boolean;
}

export interface SessionStatusPipelineOptions {
	daemon: SessionStatusDaemon;
	paths: HookPaths;
	overlay: SessionHookOverlay;
	homedir: string;
	platform: string;
	restrictFile?: (file: string) => Promise<void> | void;
	logger?: Logger;
	scheduler?: Scheduler;
	now?: () => number;
	fs?: HookFs;
	/** Test seam: the endpoint. */
	endpoint?: HookEndpoint;
	/** How often the idle clock and the spool are looked at. */
	tickMs?: number;
	/** Test seam: the transcript tail reader (a Stop without a message). */
	readTail?: (file: string, bytes: number) => Promise<string>;
	/** P2: the screen rules (default: the files the node ships). */
	rules?: SessionRulesEngine;
	/** How often the screen rules look (default {@link FLEET_SESSION_RULE_INTERVAL_MS}). */
	rulesTickMs?: number;
}

interface TrackedSession {
	provider: FleetSessionProvider;
	kind: FleetSessionKind;
	snapshot: FleetSessionStatusSnapshot;
	/** The sequence of the last report sent (0 = never reported). */
	statusSeq: number;
	/** Evidence for this session is applied one piece at a time, in arrival order. */
	queue: Promise<void>;
	/** When a hook last spoke (the screen rules stay quiet for 10 s after, FR-34). */
	lastHookAt: number;
	/** When output last arrived (the rules only look at a session that moved recently). */
	lastOutputAt: number;
	/** When the node last typed an answer (a rule never re-raises the prompt it just answered). */
	answeredAt: number;
	/** attention key → optionId → keys, for prompts a screen rule raised (FR-35). */
	ruleKeys: Map<string, Record<string, string>>;
	/** A screen read for this session is in flight. */
	reading: boolean;
}

const isInfoList = (value: unknown): value is { sessions: DaemonSessionInfo[] } =>
	typeof value === 'object' && value !== null && Array.isArray((value as { sessions?: unknown }).sessions);

/** The idle clock and the spool are looked at this often. */
const DEFAULT_TICK_MS = 15_000;

/** The screen rules look at a session whose output moved this recently, or that waits on someone. */
const RULES_RECENT_OUTPUT_MS = 60_000;

/** After an answer the rules leave the prompt alone this long (the CLI is redrawing). */
const RULES_AFTER_ANSWER_MS = 5_000;

export class SessionStatusPipeline {
	private readonly sessions = new Map<string, TrackedSession>();
	private readonly endpoint: HookEndpoint;
	private readonly scheduler: Scheduler;
	private readonly now: () => number;
	private readonly unsubscribes: Array<() => void> = [];
	private link: SessionStatusLink | null = null;
	private linkUnsubscribe: (() => void) | null = null;
	private lastLinkGeneration: number | null = null;
	private lastSeq = 0;
	private timer: unknown = null;
	private rulesTimer: unknown = null;
	private readonly rules: SessionRulesEngine;
	private started = false;
	private stopped = false;
	private spoolPending = 0;
	private unknownEvents = 0;
	private draining = false;

	constructor(private readonly options: SessionStatusPipelineOptions) {
		this.scheduler = options.scheduler ?? systemScheduler;
		this.now = options.now ?? (() => Date.now());
		// FR-36: an invalid rules file fails here, naming its rule id.
		this.rules = options.rules ?? new SessionRulesEngine();
		this.endpoint =
			options.endpoint ??
			new HookEndpoint({
				// A session the node just launched (its overlay exists) is known before the
				// daemon's `started` has been followed up — its first hook may beat that.
				isKnownSession: (sessionId) =>
					this.sessions.has(sessionId) || options.overlay.hooksFor(sessionId) !== null,
				onEvent: (event) => this.onHookEvent(event),
				now: this.now,
				warn: (message) => options.logger?.warn(message)
			});
	}

	/**
	 * Bring the endpoint up and rewrite the endpoint file and the client (FR-2:
	 * at EVERY start, so a CLI that outlived the last node reads the new port),
	 * then follow the daemon. A failure here never stops the node or a
	 * session: status then comes from the screen and the process.
	 */
	async start(): Promise<void> {
		if (this.started || this.stopped) return;
		this.started = true;
		this.unsubscribes.push(
			this.options.daemon.onConnected(() => void this.refreshFromDaemon()),
			this.options.daemon.onEvent((event) => this.onDaemonEvent(event))
		);
		try {
			const { port, token } = await this.endpoint.start();
			await writeHookEndpointFile({
				paths: this.options.paths,
				port,
				token,
				now: this.now,
				platform: this.options.platform,
				...(this.options.fs ? { fs: this.options.fs } : {}),
				...(this.options.restrictFile ? { restrictFile: this.options.restrictFile } : {})
			});
			await materializeHookClient({
				paths: this.options.paths,
				platform: this.options.platform,
				...(this.options.fs ? { fs: this.options.fs } : {}),
				...(this.options.restrictFile ? { restrictFile: this.options.restrictFile } : {})
			});
		} catch (error) {
			this.options.logger?.warn(
				`Session status: the hook endpoint is not available (${error instanceof Error ? error.message : String(error)}); status comes from the screen and the process`
			);
		}
		this.schedule();
		this.scheduleRules();
	}

	/** Stop the endpoint and the timers. The endpoint FILE stays, so hooks spool while the node is down. */
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
		this.timer = null;
		if (this.rulesTimer !== null) this.scheduler.clearTimeout(this.rulesTimer);
		this.rulesTimer = null;
		for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
		this.linkUnsubscribe?.();
		this.linkUnsubscribe = null;
		this.link = null;
		await this.endpoint.stop();
	}

	/** Bind the link: reports go out on channel 0; every (re)connect re-sends the current status. */
	bindLink(link: SessionStatusLink): void {
		if (this.link === link) return;
		this.linkUnsubscribe?.();
		this.link = link;
		this.lastLinkGeneration = null;
		this.linkUnsubscribe = link.onChange((state) => {
			if (state.phase !== 'connected' || state.linkGeneration === null) return;
			if (state.linkGeneration === this.lastLinkGeneration) return;
			this.lastLinkGeneration = state.linkGeneration;
			this.resendAll();
		});
	}

	/** Whether the pipeline follows this session (the endpoint's unknown-session check, U3). */
	knows(sessionId: string): boolean {
		return this.sessions.has(sessionId);
	}

	/** The current snapshot of a session (P2: the answer typist reads its attention). */
	current(sessionId: string): FleetSessionStatusSnapshot | null {
		return this.sessions.get(sessionId)?.snapshot ?? null;
	}

	/** The current attention of a session, or null. */
	attentionOf(sessionId: string): FleetSessionAttention | null {
		return this.sessions.get(sessionId)?.snapshot.attention ?? null;
	}

	/**
	 * Evidence from the node's other observers (P2: the screen rules, the
	 * answer typist). Applied in order with the hooks'; unknown sessions dropped.
	 */
	addEvidence(sessionId: string, evidence: readonly FleetSessionEvidence[]): Promise<void> {
		return this.enqueue(sessionId, async () => evidence);
	}

	/**
	 * Answer what a session asks (P2, `session.answer`, spec FR-28, FR-29):
	 * the key must be the session's CURRENT question or permission — else
	 * `invalid` "Already answered" (it was answered in the terminal, or it
	 * moved on) and nothing is typed; then the keys the CLI expects
	 * (`answer-typist.ts`) go into the session through the daemon, and the
	 * prompt clears here first (`answered`), which reports `session.attention
	 * null` and `working`. A daemon that refuses the input (the fleet stop
	 * blocked it) leaves the prompt as it was.
	 */
	async answer(
		sessionId: string,
		params: FleetSessionAnswerParams
	): Promise<{ ok: true } | { ok: false; error: FleetLinkError }> {
		const tracked = this.sessions.get(sessionId);
		const attention = tracked?.snapshot.attention ?? null;
		if (!tracked || !attention || attention.key !== params.key || !isFleetSessionDecisionReason(attention.reason)) {
			return { ok: false, error: makeFleetLinkError('invalid', 'Already answered') };
		}
		const typed = keysForAnswer({
			provider: tracked.provider,
			attention,
			answer: params.answer,
			ruleKeys: tracked.ruleKeys.get(attention.key) ?? null
		});
		if (!typed.ok) return { ok: false, error: makeFleetLinkError('invalid', typed.hint) };
		try {
			await this.options.daemon.request('input', { sessionId, data: typed.keys });
		} catch (error) {
			const code =
				typeof (error as { code?: unknown })?.code === 'string'
					? ((error as { code: string }).code as FleetLinkError['code'])
					: null;
			return {
				ok: false,
				error: makeFleetLinkError(code ?? 'operation_failed', 'the answer could not be typed into the session')
			};
		}
		tracked.answeredAt = this.now();
		tracked.ruleKeys.delete(attention.key);
		await this.addEvidence(sessionId, [{ source: 'structured', event: 'answered', at: this.now() }]);
		return { ok: true };
	}

	/**
	 * What a driver typed (the session module tells us): Ctrl-C in a running
	 * turn is the person stopping it — `done · interrupted`, never news (U15).
	 * Only the fact is read; the bytes go nowhere.
	 */
	observeInput(sessionId: string, data: string | Uint8Array): void {
		const tracked = this.sessions.get(sessionId);
		if (!tracked || tracked.provider === 'shell') return;
		const hasInterrupt = typeof data === 'string' ? data.includes('\u0003') : data.includes(0x03);
		if (!hasInterrupt) return;
		void this.addEvidence(sessionId, [{ source: 'exit', event: 'interrupt', at: this.now() }]);
	}

	/** The heartbeat's `daemon.hooks` counters (CONTRACTS §1.1, spec FR-6, §5.11). */
	hooksReport(): Record<string, number> {
		const counters = this.endpoint.snapshotCounters();
		return {
			badTokenLastMinute: this.endpoint.badTokenLastMinute(),
			spooled: this.spoolPending,
			events: counters.ok,
			spoolApplied: counters.spooled,
			unknownSession: counters.unknownSession,
			malformed: counters.malformed,
			unknownEvents: this.unknownEvents,
			endpointUp: this.endpoint.listeningPort === null ? 0 : 1
		};
	}

	// ─── Inputs ────────────────────────────────────────────────────────────

	private onHookEvent(event: HookEndpointEvent, retried = false): void {
		const tracked = this.sessions.get(event.sessionId);
		if (!tracked) {
			// Launched a moment ago: follow it first, then apply once (an unknown one is dropped, U3).
			if (!retried) void this.track(event.sessionId).then(() => this.onHookEvent(event, true));
			return;
		}
		tracked.lastHookAt = this.now();
		void this.enqueue(event.sessionId, async () => {
			const evidence = await normalizeHookEvent(event, {
				homedir: this.options.homedir,
				...(this.options.readTail ? { readTail: this.options.readTail } : {})
			});
			if (evidence.length === 0) this.unknownEvents += 1;
			return evidence;
		});
	}

	private onDaemonEvent(event: DaemonWatchEvent): void {
		switch (event.event) {
			case 'started':
				void this.track(event.id);
				return;
			case 'activity': {
				const tracked = this.sessions.get(event.id);
				if (tracked) tracked.lastOutputAt = this.now();
				void this.addEvidence(event.id, [{ source: 'exit', event: 'activity', at: this.now() }]);
				return;
			}
			case 'exited': {
				const tracked = this.sessions.get(event.id);
				if (tracked) {
					void tracked.queue.then(() => {
						this.sessions.delete(event.id);
					});
				}
				this.rules.forget(event.id);
				void this.options.overlay.release(event.id);
				return;
			}
			default:
				return;
		}
	}

	/** Every live session the daemon holds is followed; ended ones are let go. */
	private async refreshFromDaemon(): Promise<void> {
		let sessions: DaemonSessionInfo[] = [];
		try {
			const listed = await this.options.daemon.request('list');
			if (isInfoList(listed)) sessions = listed.sessions;
		} catch {
			return;
		}
		const alive = new Set<string>();
		for (const info of sessions) {
			if (!info.alive) continue;
			alive.add(info.id);
			this.ensureTracked(info);
		}
		for (const id of [...this.sessions.keys()]) {
			if (!alive.has(id)) this.sessions.delete(id);
		}
		void this.drainSpool();
	}

	private async track(sessionId: string): Promise<void> {
		if (this.sessions.has(sessionId)) return;
		try {
			const listed = await this.options.daemon.request('list');
			if (!isInfoList(listed)) return;
			const info = listed.sessions.find((entry) => entry.id === sessionId);
			if (info?.alive) this.ensureTracked(info);
		} catch {
			// The next connect re-lists.
		}
	}

	private ensureTracked(info: DaemonSessionInfo): void {
		if (!isFleetDaemonSessionId(info.id) || this.sessions.has(info.id)) return;
		if (info.provider === 'shell') {
			this.options.overlay.remember(info.id, { provider: 'shell', injected: false, events: [] });
		}
		this.sessions.set(info.id, {
			provider: info.provider,
			kind: info.kind,
			snapshot: initialFleetSessionStatus(this.now()),
			statusSeq: 0,
			queue: Promise.resolve(),
			lastHookAt: 0,
			lastOutputAt: this.now(),
			answeredAt: 0,
			ruleKeys: new Map(),
			reading: false
		});
	}

	// ─── Merging and reporting ─────────────────────────────────────────────

	private enqueue(sessionId: string, produce: () => Promise<readonly FleetSessionEvidence[]>): Promise<void> {
		const tracked = this.sessions.get(sessionId);
		if (!tracked) return Promise.resolve();
		const run = tracked.queue
			.then(async () => {
				const evidence = await produce();
				for (const piece of evidence) this.apply(sessionId, piece);
			})
			.catch((error: unknown) => {
				this.options.logger?.warn(
					`Session status for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
				);
			});
		tracked.queue = run;
		return run;
	}

	private apply(sessionId: string, evidence: FleetSessionEvidence): void {
		const tracked = this.sessions.get(sessionId);
		if (!tracked) return;
		const result = mergeFleetSessionEvidence(tracked.snapshot, evidence, {
			sessionId,
			provider: tracked.provider
		});
		tracked.snapshot = result.next;
		if (result.changed || (result.attentionChanged && tracked.statusSeq === 0)) this.sendStatus(sessionId, tracked);
		if (result.attentionChanged) this.sendAttention(sessionId, tracked, result.finished);
	}

	private nextSeq(): number {
		this.lastSeq = Math.max(this.lastSeq + 1, this.now());
		return this.lastSeq;
	}

	private statusMessage(sessionId: string, tracked: TrackedSession): FleetSessionStatusMessage | null {
		const snapshot = tracked.snapshot;
		if (snapshot.state === 'ended' || !snapshot.lastEvidence) return null;
		const hooks: FleetSessionHooks | null = this.options.overlay.hooksFor(sessionId);
		return {
			type: 'session.status',
			sessionId,
			seq: tracked.statusSeq,
			state: snapshot.state,
			outcome: snapshot.outcome,
			stateChangedAt: new Date(snapshot.stateChangedAt).toISOString(),
			lastEvidence: {
				source: snapshot.lastEvidence.source,
				at: new Date(snapshot.lastEvidence.at).toISOString(),
				detail: {
					event: snapshot.lastEvidence.event,
					seq: tracked.statusSeq,
					...(snapshot.lastEvidence.rule ? { rule: snapshot.lastEvidence.rule } : {}),
					userLine: snapshot.userLine,
					agentLine: snapshot.agentLine
				}
			},
			...(hooks ? { hooks } : {}),
			boundaryUntil: snapshot.boundaryUntil === null ? null : new Date(snapshot.boundaryUntil).toISOString()
		};
	}

	private sendStatus(sessionId: string, tracked: TrackedSession): void {
		tracked.statusSeq = this.nextSeq();
		const message = this.statusMessage(sessionId, tracked);
		if (message) this.send(message as unknown as FleetLinkExtensionMessage);
	}

	private sendAttention(sessionId: string, tracked: TrackedSession, finished: boolean): void {
		const message: FleetSessionAttentionMessage = {
			type: 'session.attention',
			sessionId,
			seq: this.nextSeq(),
			attention: tracked.snapshot.attention,
			...(finished ? { finished: true } : {})
		};
		this.send(message as unknown as FleetLinkExtensionMessage);
	}

	private send(message: FleetLinkExtensionMessage): void {
		const link = this.link;
		if (!link || link.getState().phase !== 'connected') return;
		link.sendControl(message);
	}

	/** After a (re)connect: every session that has reported says where it stands now. */
	private resendAll(): void {
		for (const [sessionId, tracked] of this.sessions) {
			if (tracked.statusSeq === 0) continue;
			const message = this.statusMessage(sessionId, tracked);
			if (message) this.send(message as unknown as FleetLinkExtensionMessage);
			if (tracked.snapshot.attention) this.sendAttention(sessionId, tracked, false);
		}
	}

	// ─── The clock and the spool ───────────────────────────────────────────

	private schedule(): void {
		if (this.stopped) return;
		this.timer = this.scheduler.setTimeout(() => {
			this.timer = null;
			this.tick();
			this.schedule();
		}, this.options.tickMs ?? DEFAULT_TICK_MS);
	}

	private tick(): void {
		const at = this.now();
		for (const sessionId of this.sessions.keys()) {
			void this.addEvidence(sessionId, [{ source: 'exit', event: 'silence', at }]);
		}
		void this.drainSpool();
	}

	// ─── The screen rules (P2, FR-33 … FR-36) ──────────────────────────────

	private scheduleRules(): void {
		if (this.stopped) return;
		this.rulesTimer = this.scheduler.setTimeout(() => {
			this.rulesTimer = null;
			this.rulesTick();
			this.scheduleRules();
		}, this.options.rulesTickMs ?? FLEET_SESSION_RULE_INTERVAL_MS);
	}

	/**
	 * Every 2 s: a session with rules, no hook evidence in the last 10 s, not
	 * answered a moment ago, and either moving (output in the last minute) or
	 * waiting on someone, has its screen read and judged. One read in flight
	 * per session.
	 */
	private rulesTick(): void {
		const now = this.now();
		for (const [sessionId, tracked] of this.sessions) {
			if (tracked.reading || !this.rules.hasRules(tracked.provider)) continue;
			if (now - tracked.lastHookAt < FLEET_SESSION_RULE_QUIET_MS) continue;
			if (now - tracked.answeredAt < RULES_AFTER_ANSWER_MS) continue;
			const waiting = tracked.snapshot.state === 'needs_you';
			if (!waiting && now - tracked.lastOutputAt > RULES_RECENT_OUTPUT_MS) continue;
			tracked.reading = true;
			void this.readAndJudge(sessionId, tracked).finally(() => {
				tracked.reading = false;
			});
		}
	}

	private async readAndJudge(sessionId: string, tracked: TrackedSession): Promise<void> {
		let screen: { text?: unknown; title?: unknown } | null = null;
		try {
			screen = await this.options.daemon.request<{ text?: unknown; title?: unknown }>(
				'screen',
				{ sessionId, lines: 40 },
				2_000
			);
		} catch {
			return;
		}
		if (!screen || typeof screen.text !== 'string') return;
		const match = this.rules.evaluate(
			sessionId,
			tracked.provider,
			{ screen: screen.text, title: typeof screen.title === 'string' ? screen.title : '' },
			this.now()
		);
		if (!match) return;
		await this.enqueue(sessionId, async () => [match.evidence]);
		// A prompt the rule raised is answered with the rule's keys (FR-35).
		const attention = this.sessions.get(sessionId)?.snapshot.attention;
		if (attention && Object.keys(match.keys).length > 0 && attention.reason !== 'finished') {
			tracked.ruleKeys.set(attention.key, match.keys);
		}
	}

	private async drainSpool(): Promise<void> {
		if (this.draining || this.endpoint.listeningPort === null || !this.options.daemon.healthy) return;
		this.draining = true;
		try {
			const result = await drainHookSpool({
				spoolDir: this.options.paths.spoolDir,
				ingest: (sessionId, provider, raw, at) => this.endpoint.ingestSpooled(sessionId, provider, raw, at),
				isKnownSession: (sessionId) => this.sessions.has(sessionId),
				now: this.now,
				platform: this.options.platform,
				...(this.options.fs ? { fs: this.options.fs } : {})
			});
			this.spoolPending = result.pending;
		} catch (error) {
			this.options.logger?.warn(
				`Session status: the hook spool could not be drained: ${error instanceof Error ? error.message : String(error)}`
			);
		} finally {
			this.draining = false;
		}
	}
}
