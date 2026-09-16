import { join, resolve } from 'path';
import type { AgentProfileFs } from './agent-profile';

/**
 * Agent computers — telling the Agent a person has control of its computer.
 *
 * While a person holds control of a live view, the Agent must keep its own
 * hands off the browser it shares with them, and it must learn that it is
 * paused rather than having its actions fail silently. The machine records
 * that in the Agent's OWN profile directory on this machine — the directory
 * its browser profile and file root live in, which no other Agent can read —
 * as a small file that exists exactly while control is held:
 *
 *   <profile dir>/CONTROL_HELD.json
 *     { "controlledByPerson": true, "since": "<ISO time>", "message": "…" }
 *
 * It is written when control is taken and removed when control is given back
 * or the view ends. A process that died while control was held leaves the
 * file behind with its `since`, so its age is always readable; the next
 * stretch of control of that Agent on this machine rewrites it and removes it.
 * It never carries who took control or anything they typed.
 *
 * Several live views of the same Agent on this machine share that one file,
 * and control can move from one view to another (a hand-over) with each view
 * hearing about it on its own leg, in no guaranteed order. So every marker
 * for the same file goes through ONE serialized queue in this node process
 * (the only one that runs this machine's live views), which remembers which
 * view wrote the file last: a view that gives control back removes the file
 * only while it is still the one that wrote it — never the marker a newer
 * holder has already written.
 */

export const AGENT_CONTROL_MARKER_FILE = 'CONTROL_HELD.json';

export const AGENT_CONTROL_MARKER_MESSAGE =
	'A person has taken control of this computer from Ever Works. Do not use this browser until this file is removed; it is removed when they give control back.';

export interface AgentControlMarker {
	set(controlled: boolean): Promise<void>;
}

/** Per marker file on this machine: who wrote it last, and the queue every change to it waits in. */
interface MarkerFileState {
	owner: symbol | null;
	tail: Promise<unknown>;
	pending: number;
}

const markerFiles = new Map<string, MarkerFileState>();

/** Run `work` after every earlier change to the same marker file has settled. */
function serialize<T>(path: string, work: (state: MarkerFileState) => Promise<T>): Promise<T> {
	let state = markerFiles.get(path);
	if (!state) {
		state = { owner: null, tail: Promise.resolve(), pending: 0 };
		markerFiles.set(path, state);
	}
	const current = state;
	current.pending += 1;
	const run = current.tail.then(() => work(current));
	current.tail = run.catch(() => undefined);
	return run.finally(() => {
		current.pending -= 1;
		if (current.pending === 0 && current.owner === null && markerFiles.get(path) === current) {
			markerFiles.delete(path);
		}
	});
}

export function createAgentControlMarker(options: {
	profileDir: string;
	fs: Pick<AgentProfileFs, 'writeTextFile' | 'rm'>;
	clock?: () => Date;
}): AgentControlMarker {
	const path = join(options.profileDir, AGENT_CONTROL_MARKER_FILE);
	const key = resolve(path);
	/** This view's identity for the file — opaque, and never written anywhere. */
	const self = Symbol('agent-control-marker');
	return {
		set(controlled: boolean): Promise<void> {
			return serialize(key, async (state) => {
				if (!controlled) {
					// Another view has written the marker since (a hand-over), or
					// nobody here holds it: it is not this view's to remove.
					if (state.owner !== self) return;
					await options.fs.rm(path);
					state.owner = null;
					return;
				}
				const since = (options.clock ?? (() => new Date()))().toISOString();
				await options.fs.writeTextFile(
					path,
					`${JSON.stringify({ controlledByPerson: true, since, message: AGENT_CONTROL_MARKER_MESSAGE }, null, 2)}\n`
				);
				state.owner = self;
			});
		}
	};
}
