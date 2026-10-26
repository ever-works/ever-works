import {
	FLEET_PORT_LIST_CACHE_MS,
	FLEET_PORT_PROBE_CONCURRENCY,
	FLEET_PORTS_CAPABILITY,
	FLEET_PORTS_DESKTOP_OPEN_CAPABILITY,
	FLEET_PORTS_LIST_MAX,
	FLEET_PORTS_LINK_VERBS,
	fleetPortLoopbackUrl,
	isFleetPortNumber,
	isFleetPortOpenTarget,
	makeFleetLinkError,
	parseFleetPortWatchList,
	type FleetListeningPort,
	type FleetPortDiscoveryTool,
	type FleetPortOpenNodeResult,
	type FleetPortsList
} from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import type { Logger } from '../../../logger';
import type { DesktopSourceOpener } from '../desktop';
import { MachineVerbError, type MachineVerbContext, type NodeLinkControlState, type NodeModule } from '../registry';
import { classifyListener, isSystemNoise, mergeByPort } from './classify';
import { discoverListeners, discoveryToolMissingHint, type RawListener } from './discover';
import { probeHttp, type HttpProbeOptions, type HttpProbeResult } from './http-probe';
import { joinListeners } from './join';
import { openOnDesktop, type DesktopUrlOpener } from './open-desktop';
import { openPreviewChannel, type PreviewBrowserManager } from './preview-browser';
import { openTunnelChannel, type TunnelChannelOptions } from './tunnel';
import { StoppedPortTracker, waitingRows } from './watch-list';

/**
 * Servers and ports (FL-10) — the node's `ports` module (plan §6).
 *
 * `machine` verbs (CONTRACTS §3.3; consent `manage` from the contracts
 * table, checked by the `machine` channel before these run):
 *
 *  - `ports.list { watch? }` → {@link FleetPortsList}: discover, merge by
 *    port, join programs / folders / containers, probe every candidate over
 *    HTTP from the machine itself (≤ 32 at once, 2 s each — system ports are
 *    never probed), classify, mark the ones that stopped since the last list,
 *    append waiting rows. A list is reused for 2 s (one tab or many, one
 *    machine). Reads only: never refused by the kill switch, never audited.
 *  - `ports.open { port, target, scheme?, viewId?, holder? }` — on the
 *    desktop (FL-07's opener, or the system opener when the node runs in a
 *    desktop session) or in the preview browser. State-changing: refused
 *    while the kill switch has the link paused.
 *
 * The `ports` tag is advertised under `--manage` unless the machine proved it
 * has no discovery tool; `ports-desktop` when an opener is bound and the
 * node runs with `--attend` (the platform's Open menu reads both).
 *
 * Phase 2 adds the `tunnel` channel family (`./tunnel.ts`): HTTP for one
 * port, carried over the link to the person's own browser.
 *
 * The preview picture is not here: it rides the `desktop` family
 * (`./desktop.ts`), whose `preview` source is {@link PortsModule.previewSource}.
 */

export interface PortsModuleOptions {
	runner: CommandRunner;
	platform: string;
	homedir: string;
	nodeName: string;
	/** Whether this process was started with `--attend` (desktop opens need it). */
	attend: boolean;
	/** FL-07's desktop hook, or the system opener; null when the desktop cannot be reached. */
	desktopOpener: DesktopUrlOpener | null;
	preview: PreviewBrowserManager;
	logger?: Logger;
	now?: () => number;
	probeOptions?: HttpProbeOptions;
	/** Test seam: replace discovery. */
	discover?: typeof discoverListeners;
	/** Test seam: replace the probe. */
	probe?: (port: number) => Promise<HttpProbeResult>;
	/** Test seams of the `tunnel` channel (phase 2). */
	tunnel?: TunnelChannelOptions;
}

export interface PortsModule extends NodeModule {
	/** The `desktop` family's `preview` source (`createDesktopFamilyModule({ preview })`). */
	previewSource: DesktopSourceOpener;
	/** End the preview (node stop). */
	shutdown(): Promise<void>;
}

/** A probe answer is reused this long (the tab asks every 5 s). */
const PROBE_CACHE_MS = 4_000;
/** How long a list waits for fresh probes before it answers with what it has (inside the 2 s inline window). */
const PROBE_DEADLINE_MS = 1_400;

/** The most "discovery tool missing" warnings logged per hour. */
const MISSING_TOOL_LOG_EVERY_MS = 60 * 60_000;

function verbError(code: Parameters<typeof makeFleetLinkError>[0], hint: string, details?: Record<string, unknown>) {
	return new MachineVerbError(makeFleetLinkError(code, hint, details));
}

export function createPortsModule(options: PortsModuleOptions): PortsModule {
	const now = options.now ?? (() => Date.now());
	const discover = options.discover ?? discoverListeners;
	const probe = options.probe ?? ((port: number) => probeHttp(port, options.probeOptions));
	const stopped = new StoppedPortTracker();
	let toolState: 'unknown' | 'present' | 'missing' = 'unknown';
	let lastMissingLogAt = 0;
	// Asserted, not annotated: an annotated `= null` narrows `typeof cache` below to `null` (→ `never`).
	let cache = null as {
		at: number;
		rows: FleetListeningPort[];
		tool: FleetPortDiscoveryTool;
		truncated: boolean;
	} | null;
	let building: Promise<NonNullable<typeof cache>> | null = null;
	let watchedControl: NodeLinkControlState | null = null;
	/** The last answer per port, reused for {@link PROBE_CACHE_MS} and when a fresh probe is late. */
	const probeCache = new Map<number, { at: number; result: HttpProbeResult }>();
	const probing = new Map<number, Promise<HttpProbeResult>>();
	let activeProbes = 0;
	const queued: Array<() => void> = [];
	const withProbeSlot = async <T>(task: () => Promise<T>): Promise<T> => {
		if (activeProbes >= FLEET_PORT_PROBE_CONCURRENCY) {
			await new Promise<void>((resolve) => queued.push(resolve));
		}
		activeProbes++;
		try {
			return await task();
		} finally {
			activeProbes--;
			queued.shift()?.();
		}
	};
	const probeFor = (port: number): Promise<HttpProbeResult> => {
		const cached = probeCache.get(port);
		if (cached && now() - cached.at < PROBE_CACHE_MS) return Promise.resolve(cached.result);
		let running = probing.get(port);
		if (!running) {
			running = withProbeSlot(() => probe(port))
				.then((result) => {
					probeCache.set(port, { at: now(), result });
					return result;
				})
				.finally(() => probing.delete(port));
			probing.set(port, running);
		}
		return running;
	};

	const watchControl = (control: NodeLinkControlState): void => {
		if (watchedControl === control) return;
		watchedControl = control;
		control.onChange((state) => {
			if (state.paused) void options.preview.endAll('kill_switch');
		});
	};

	const build = async (): Promise<NonNullable<typeof cache>> => {
		const outcome = await discover(options.runner, options.platform);
		if (!outcome.ok) {
			if (outcome.reason === 'missing') {
				toolState = 'missing';
				if (now() - lastMissingLogAt >= MISSING_TOOL_LOG_EVERY_MS) {
					lastMissingLogAt = now();
					options.logger?.warn(`Ports: ${outcome.detail}; the Ports tab cannot list this machine's ports`);
				}
				throw verbError('unsupported_on_node', discoveryToolMissingHint(outcome.tool, options.nodeName), {
					tool: outcome.tool
				});
			}
			throw verbError('operation_failed', `Could not list ports on ${options.nodeName} — ${outcome.detail}`, {
				tool: outcome.tool
			});
		}
		toolState = 'present';
		const merged = mergeByPort(outcome.listeners);
		const truncated = merged.length > FLEET_PORTS_LIST_MAX;
		const listeners: RawListener[] = truncated ? merged.slice(0, FLEET_PORTS_LIST_MAX) : merged;
		const joined = await joinListeners(listeners, {
			runner: options.runner,
			platform: options.platform,
			homedir: options.homedir
		});
		// System ports are never asked anything (U7). Everything else is asked
		// within the deadline, so the reply stays inside the link's inline
		// window; a probe still running then keeps going in the background and
		// fills the cache the next list (5 s later) reads.
		let resolveLate: (value: 'late') => void = () => undefined;
		const deadline = new Promise<'late'>((resolve) => {
			resolveLate = resolve;
		});
		const deadlineTimer = setTimeout(() => resolveLate('late'), PROBE_DEADLINE_MS);
		const probes = await Promise.all(
			joined.map(async (entry) => {
				if (isSystemNoise(entry.listener, options.platform)) return null;
				const port = entry.listener.port;
				const answer = await Promise.race([probeFor(port), deadline]);
				return answer === 'late' ? (probeCache.get(port)?.result ?? null) : answer;
			})
		);
		clearTimeout(deadlineTimer);
		const rows = joined.map((entry, index) =>
			classifyListener({
				listener: entry.listener,
				platform: options.platform,
				probe: probes[index],
				...(entry.program ? { program: entry.program } : {}),
				...(entry.container ? { container: entry.container } : {})
			})
		);
		const gone = stopped.stoppedSince(rows);
		return { at: now(), rows: [...rows, ...gone], tool: outcome.tool, truncated };
	};

	const currentRows = async (): Promise<NonNullable<typeof cache>> => {
		if (cache && now() - cache.at < FLEET_PORT_LIST_CACHE_MS) return cache;
		if (!building) {
			building = build().finally(() => {
				building = null;
			});
		}
		cache = await building;
		return cache;
	};

	const list = async (context: MachineVerbContext): Promise<FleetPortsList> => {
		watchControl(context.control);
		const watch = parseFleetPortWatchList(context.params.watch);
		const built = await currentRows();
		const present = new Set(built.rows.filter((row) => !row.stopped).map((row) => row.port));
		const result: FleetPortsList = {
			ports: [...built.rows, ...waitingRows(watch, present)],
			sampledAt: new Date(built.at).toISOString(),
			discovery: built.tool
		};
		if (built.truncated) result.truncated = true;
		return result;
	};

	const open = async (context: MachineVerbContext): Promise<FleetPortOpenNodeResult> => {
		watchControl(context.control);
		const { port, target } = context.params;
		if (!isFleetPortNumber(port)) throw verbError('invalid', 'port', { field: 'port' });
		if (!isFleetPortOpenTarget(target)) throw verbError('invalid', 'target', { field: 'target' });
		const scheme = context.params.scheme === 'https' ? 'https' : 'http';
		const url = fleetPortLoopbackUrl(port, scheme);
		// What the last list knew about the port, for the platform's audit row.
		const known = cache?.rows.find((row) => row.port === port && !row.stopped);
		const about = { program: known?.program?.name ?? null, container: known?.container?.name ?? null };
		if (target === 'desktop') {
			await openOnDesktop({
				url,
				attend: options.attend && context.consents.attend,
				opener: options.desktopOpener,
				nodeName: options.nodeName
			});
			return { target, url, ...about };
		}
		const viewId = typeof context.params.viewId === 'string' ? context.params.viewId : '';
		const holder =
			typeof context.params.holder === 'string' && context.params.holder.trim().length > 0
				? context.params.holder.trim().slice(0, 80)
				: 'Someone';
		await options.preview.open({ url, port, viewId, holder });
		return { target, url, viewId, ...about };
	};

	return {
		id: 'ports',
		tags: (environment) => {
			if (!environment.consents.manage || toolState === 'missing') return [];
			const tags = [FLEET_PORTS_CAPABILITY];
			if (environment.consents.attend && options.attend && options.desktopOpener) {
				tags.push(FLEET_PORTS_DESKTOP_OPEN_CAPABILITY);
			}
			return tags;
		},
		machineVerbs: {
			[FLEET_PORTS_LINK_VERBS.list]: { stateChanging: false, run: list },
			[FLEET_PORTS_LINK_VERBS.open]: { stateChanging: true, run: open }
		},
		// Phase 2 — Preview in my browser: HTTP for one port over the link
		// (`./tunnel.ts`); the family's consent (`manage`) is checked by the link.
		families: [{ family: 'tunnel', open: (context) => openTunnelChannel(context, options.tunnel) }],
		previewSource: (context) => {
			watchControl(context.control);
			if (context.control.paused) {
				return { ok: false, error: makeFleetLinkError('kill_switch', 'clear it under Settings → Fleet') };
			}
			return openPreviewChannel(context, options.preview);
		},
		shutdown: () => options.preview.endAll('stopped')
	};
}

export { createSystemBrowserOpener, type DesktopUrlOpener } from './open-desktop';
export {
	defaultPreviewProfileRoot,
	PreviewBrowserManager,
	PREVIEW_PROFILE_ROOT_ENV,
	type PreviewBrowserStarter,
	type PreviewSurface
} from './preview-browser';
