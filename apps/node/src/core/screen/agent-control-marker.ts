import { join } from 'path';
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
 */

export const AGENT_CONTROL_MARKER_FILE = 'CONTROL_HELD.json';

export const AGENT_CONTROL_MARKER_MESSAGE =
	'A person has taken control of this computer from Ever Works. Do not use this browser until this file is removed; it is removed when they give control back.';

export interface AgentControlMarker {
	set(controlled: boolean): Promise<void>;
}

export function createAgentControlMarker(options: {
	profileDir: string;
	fs: Pick<AgentProfileFs, 'writeTextFile' | 'rm'>;
	clock?: () => Date;
}): AgentControlMarker {
	const path = join(options.profileDir, AGENT_CONTROL_MARKER_FILE);
	return {
		async set(controlled: boolean): Promise<void> {
			if (!controlled) {
				await options.fs.rm(path);
				return;
			}
			const since = (options.clock ?? (() => new Date()))().toISOString();
			await options.fs.writeTextFile(
				path,
				`${JSON.stringify({ controlledByPerson: true, since, message: AGENT_CONTROL_MARKER_MESSAGE }, null, 2)}\n`
			);
		}
	};
}
