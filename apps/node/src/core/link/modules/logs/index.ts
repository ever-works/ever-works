import {
	FLEET_LOGS_CAPABILITY,
	FLEET_LOGS_SOURCES_VERB,
	fleetLogSystemSourcesFor,
	parseFleetLogSourceId,
	type FleetLogSourceList
} from '@ever-works/contracts';
import { resolveUnderRoots, type AllowedRoot } from '../../allowed-roots';
import type { MachineVerb, NodeModule } from '../registry';
import { createContainerReader } from './container-source';
import { createEventLogReader } from './event-log-source';
import { createFileReader } from './file-source';
import { createJournalReader } from './journal-source';
import { openLogChannel } from './log-channel';
import { LogReadError, type LogIo } from './log-io';
import type { LogReader } from './log-reader';
import { listLogSources } from './log-sources';
import { createServiceReader } from './service-source';
import { createUnifiedLogReader } from './unified-log-source';

/**
 * Logs on computers (FL-08, plan §6, T-08) — the node's `logs` module:
 *
 *  - the **`logs` channel family** (`log-channel.ts`): one open source (or
 *    merged set) per channel, scanned, framed and paced on this machine;
 *  - the **`logs.sources` machine verb** (`log-sources.ts`, CONTRACTS §3.3
 *    rev 4): the four groups, re-listed per call;
 *  - the **`logs` tag** under `--manage` (CONTRACTS §1.2).
 *
 * Both need `--manage`: the link checks the family's and the verb's consent
 * on this machine before either runs (FL-02 registry), whatever the platform
 * says. Every source id is re-validated HERE before a reader is built: a
 * system log this platform does not have is `unsupported_on_node`; a file
 * must canonicalise under an allowed root (R-18 — the standard log
 * directories, the workspace root, `--files-root` folders, ready checkouts),
 * else `invalid` with the spec's hint (U14); a file this user cannot read is
 * `unsupported_on_node` "readable by root only" (U6); the Security log needs
 * an administrator (U7).
 */

export interface LogsLinkModuleOptions {
	io: LogIo;
	/** The allowed roots (`resolveAllowedRoots` with the standard log directories), read per call. */
	roots(): Promise<readonly AllowedRoot[]>;
	nodeName: string;
}

const OUTSIDE_ROOTS = "Only files under this computer's shared folders and standard log directories can be read";

function basename(path: string): string {
	return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1) || path;
}

export function createLogsLinkModule(options: LogsLinkModuleOptions): NodeModule {
	const { io, nodeName } = options;

	async function openReader(id: string, roots: readonly AllowedRoot[]): Promise<LogReader> {
		const ref = parseFleetLogSourceId(id);
		if (!ref) throw new LogReadError('invalid', 'source');
		switch (ref.kind) {
			case 'system': {
				const key = ref.key as ReturnType<typeof fleetLogSystemSourcesFor>[number];
				if (!fleetLogSystemSourcesFor(io.platform).includes(key)) {
					throw new LogReadError('unsupported_on_node', `that system log is not on this kind of computer (${io.platform})`);
				}
				switch (key) {
					case 'journal':
						return createJournalReader(io);
					case 'kernel':
						return createJournalReader(io, { kernel: true });
					case 'unified':
						return createUnifiedLogReader(io);
					case 'event-system':
						return createEventLogReader(io, { logs: ['System'] });
					case 'event-application':
						return createEventLogReader(io, { logs: ['Application'] });
					case 'event-security':
						if (!(await io.isElevated())) {
							throw new LogReadError(
								'unsupported_on_node',
								'Run the node service as an administrator to read the Security log'
							);
						}
						return createEventLogReader(io, { logs: ['Security'] });
					default:
						throw new LogReadError('unsupported_on_node', 'that system log is not on this kind of computer');
				}
			}
			case 'file': {
				const under = await resolveUnderRoots(ref.key, roots, io.platform, io.fs);
				if (!under.ok) {
					if (under.reason === 'missing') throw new LogReadError('not_found', `${basename(ref.key)} is gone`);
					throw new LogReadError('invalid', OUTSIDE_ROOTS);
				}
				const stat = await io.fs.stat(under.canonical).catch(() => null);
				if (!stat) throw new LogReadError('not_found', `${basename(ref.key)} is gone`);
				if (!stat.isFile) throw new LogReadError('invalid', `${basename(ref.key)} is not a file`);
				if (!(await io.fs.canRead(under.canonical))) {
					throw new LogReadError(
						'unsupported_on_node',
						`Readable by ${io.platform === 'win32' ? 'an administrator' : 'root'} only on ${nodeName}`
					);
				}
				return createFileReader(io, under.canonical);
			}
			case 'container':
				return createContainerReader(io, ref.key, nodeName);
			case 'service':
				return createServiceReader(io, ref.key);
			default:
				throw new LogReadError('invalid', 'source');
		}
	}

	const openReaders = async (sources: readonly string[]): Promise<LogReader[]> => {
		const roots = await options.roots();
		const readers: LogReader[] = [];
		for (const id of sources) readers.push(await openReader(id, roots));
		return readers;
	};

	const sourcesVerb: MachineVerb = {
		stateChanging: false,
		run: async (context): Promise<FleetLogSourceList> =>
			listLogSources({ io, roots: await options.roots(), nodeName: context.nodeName, signal: context.signal })
	};

	return {
		id: 'logs',
		tags: (environment) => (environment.consents.manage ? [FLEET_LOGS_CAPABILITY] : []),
		families: [
			{
				family: 'logs',
				open: (context) => openLogChannel(context, { timers: io, openReaders })
			}
		],
		machineVerbs: { [FLEET_LOGS_SOURCES_VERB]: sourcesVerb }
	};
}

export { createNodeLogIo, type LogIo } from './log-io';
