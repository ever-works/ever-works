import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { detectDiskFreeBytes, type DiskProbeIo } from '../telemetry-probe';

/**
 * Free bytes on the volume that will hold the workspace root.
 *
 * The root itself may not exist yet — a freshly enrolled node creates
 * `~/.ever-works/fleet-workspaces` on its first provision — and
 * `fs.statfs` on a missing path answers with an error the probe maps to
 * null, which the admission rules read as "unknown, admit". That would
 * let the very first job on an already-full machine through the gate only
 * to fail inside git. So the reading is taken on the nearest ancestor that
 * exists, which is on the same volume for every path a root can be
 * created at.
 *
 * Null still means "unknown": an unmounted volume, a runtime without
 * `statfs`, a permission error. Callers admit on null and the heartbeat
 * simply carries no figure.
 */
export async function measureWorkspaceFreeBytes(probe: DiskProbeIo, rootPath: string): Promise<number | null> {
	let candidate = rootPath;
	for (;;) {
		try {
			await fs.lstat(candidate);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				return null;
			}
			const parent = dirname(candidate);
			if (parent === candidate) {
				return null;
			}
			candidate = parent;
		}
	}
	return detectDiskFreeBytes(probe, candidate);
}
