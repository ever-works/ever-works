import { constants as fsConstants, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { ExclusiveAtomicFileOps, TempSweepOps } from './atomic-state-file';

/**
 * The real-disk primitives behind `replaceFileAtomically` (see
 * `atomic-state-file.ts`), shared by the config filesystem (`node-io`) and
 * the screen helper's trust store.
 */
export function createNodeAtomicFileOps(
	platform: string = process.platform
): Required<ExclusiveAtomicFileOps> & Required<TempSweepOps> {
	return {
		createFileExclusive: async (filePath, content) => {
			// 0600 at creation: owner-only from the first instant on POSIX
			// (umask can only remove bits). On Windows the mode is ignored and
			// the caller's `tighten` applies the ACL before any content lands.
			await fsp.writeFile(filePath, content, {
				encoding: 'utf8',
				mode: 0o600,
				flag: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
			});
		},
		writeExistingFile: async (filePath, content) => {
			// No O_CREAT: if the tightened temp file vanished, this fails (ENOENT)
			// rather than create a fresh file with default permissions around the
			// content. No O_TRUNC either: without O_CREAT, libuv on Windows answers
			// it with EINVAL. The explicit truncate below cuts any older tail.
			const handle = await fsp.open(filePath, fsConstants.O_WRONLY);
			try {
				await handle.writeFile(content);
				await handle.truncate(
					typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength
				);
				// On disk before the rename makes it the real file: otherwise a
				// power cut could still publish an empty file under the new name.
				await handle.sync();
			} finally {
				await handle.close();
			}
		},
		// libuv: rename(2) on POSIX, MoveFileExW(MOVEFILE_REPLACE_EXISTING) on Windows.
		rename: (from, to) => fsp.rename(from, to),
		link: (existing, newPath) => fsp.link(existing, newPath),
		remove: async (filePath) => {
			await fsp.rm(filePath, { force: true });
		},
		syncDirectory: async (dirPath) => {
			if (platform === 'win32') return;
			const handle = await fsp.open(dirPath, 'r');
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		},
		readDirectory: async (dirPath) => {
			try {
				return await fsp.readdir(dirPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
				throw error;
			}
		},
		modifiedAtMs: async (filePath) => {
			try {
				return (await fsp.stat(filePath)).mtimeMs;
			} catch {
				return null;
			}
		},
		dirname: (filePath) => (platform === 'win32' ? path.win32 : path.posix).dirname(filePath)
	};
}
