import { promises as fs } from 'fs';
import { join } from 'path';
import type { FleetAgentTaskContainmentDowngrade } from '@ever-works/contracts';
import type { CodexUserSettings } from './model-cli';

/**
 * works-security finding 5 (node 0.2.7) — the Codex items of the re-audit,
 * reported on the run instead of only in the trust model.
 *
 * Two things a fleet Codex run may get less of than control 16 suggests,
 * neither of which this node can measure without a Codex install on the PC:
 *
 *  1. **Repository-local Codex layers.** A checkout can carry its own
 *     `.codex/config.toml` (MCP servers, `notify`, sandbox and approval
 *     overrides) and `.codex/hooks.json` (commands run on session events).
 *     Codex loads a project layer only for a TRUSTED project, and trust
 *     lives in the user config that `--ignore-user-config` drops — so the
 *     layer should never load on a fleet run. "Should" is not "measured":
 *     the run says so when the checkout carries one, and names the files.
 *  2. **No `[windows] sandbox` on native Windows.** Without the owner's
 *     setting (kept under `--ignore-user-config`, see
 *     {@link CodexUserSettings}), Codex on native Windows enforces no OS
 *     sandbox around the model's own shell commands, so `workspace-write`
 *     is a convention there, not a boundary.
 *
 * Both are DISCLOSURES, in the `containment.downgrades` block every run
 * already carries: a downgrade never fails a run, it records that the
 * verdict was produced with less containment than the design intends.
 * Nothing here writes into the checkout and nothing opens a repository
 * file — presence is an `lstat`, so a planted multi-gigabyte config costs
 * the node nothing.
 */

/** The repository-relative Codex layers a checkout can carry, `/`-separated. */
export const CODEX_REPOSITORY_LAYER_PATHS: readonly string[] = ['.codex/config.toml', '.codex/hooks.json'];

/** Whether one repository path exists — `unknown` when the node could not look. */
export type RepositoryLayerPresence = 'present' | 'absent' | 'unknown';

/** Read-only presence seam over the checkout. Never opens the file. */
export interface RepositoryLayerFs {
	presence(path: string): Promise<RepositoryLayerPresence>;
}

/**
 * Production seam: `lstat` only (a link named `.codex/config.toml` is still
 * a layer Codex would follow). `ENOENT` / `ENOTDIR` is absent; any other
 * error is `unknown`, which is reported, never read as absent.
 */
export const defaultRepositoryLayerFs: RepositoryLayerFs = {
	presence: async (path) => {
		try {
			await fs.lstat(path);
			return 'present';
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown';
		}
	}
};

/** Stable slug of the repository-layer disclosure. */
export const CODEX_REPOSITORY_CONFIG_CONTROL = 'codex-repository-config';

/** Stable slug of the Windows sandbox disclosure. */
export const CODEX_WINDOWS_SANDBOX_CONTROL = 'codex-windows-sandbox';

/**
 * The repository-layer disclosure for one Codex run, or null when the
 * checkout carries none (or no seam is wired — a hand-built `io` reads no
 * disk, exactly like `managedMcpConfigFs`).
 *
 * Only the workspace root is looked at: Codex reads project layers from the
 * directories between the project root and its `-C` working directory, and
 * the node starts it with `-C` at the worktree root. Mounts are extra
 * writable roots (`--add-dir`), never the working directory.
 */
export async function auditCodexRepositoryLayers(input: {
	workspacePath: string;
	fs: RepositoryLayerFs | undefined;
}): Promise<FleetAgentTaskContainmentDowngrade | null> {
	if (!input.fs) return null;
	const present: string[] = [];
	const unknown: string[] = [];
	for (const layer of CODEX_REPOSITORY_LAYER_PATHS) {
		let presence: RepositoryLayerPresence;
		try {
			presence = await input.fs.presence(join(input.workspacePath, ...layer.split('/')));
		} catch {
			presence = 'unknown';
		}
		if (presence === 'present') present.push(layer);
		else if (presence === 'unknown') unknown.push(layer);
	}
	if (present.length > 0) {
		return {
			control: CODEX_REPOSITORY_CONFIG_CONTROL,
			reason:
				`the checkout carries a repository-local Codex layer (${present.join(', ')}); Codex loads one only ` +
				'for a trusted project and this run reads no trust entry (--ignore-user-config), not yet measured ' +
				'on this CLI version'
		};
	}
	if (unknown.length > 0) {
		return {
			control: CODEX_REPOSITORY_CONFIG_CONTROL,
			reason:
				`the node could not check the checkout for a repository-local Codex layer (${unknown.join(', ')}); ` +
				'Codex loads one only for a trusted project and this run reads no trust entry (--ignore-user-config)'
		};
	}
	return null;
}

/**
 * The Windows sandbox disclosure for one Codex run, or null when it does
 * not apply (not Windows, or the owner's `[windows] sandbox` was kept).
 * A run with `--dangerously-bypass-approvals-and-sandbox` is reported too:
 * it has no sandbox whatever the setting says, and the switch that allows
 * it (control 18) is the owner's, on this PC.
 */
export function codexWindowsSandboxDowngrade(input: {
	platform: NodeJS.Platform;
	settings: CodexUserSettings | undefined;
	skipPermissions: boolean;
}): FleetAgentTaskContainmentDowngrade | null {
	if (input.platform !== 'win32') return null;
	if (input.skipPermissions) {
		return {
			control: CODEX_WINDOWS_SANDBOX_CONTROL,
			reason:
				'Codex ran with --dangerously-bypass-approvals-and-sandbox (allowed by this PC owner), so no sandbox ' +
				"bounded the model's own shell commands"
		};
	}
	if (input.settings?.windowsSandbox) return null;
	return {
		control: CODEX_WINDOWS_SANDBOX_CONTROL,
		reason:
			"Codex on native Windows ran without a [windows] sandbox setting in the owner's config, so no OS " +
			"sandbox enforced the workspace-write boundary for the model's own shell commands"
	};
}

/** The record with the extra disclosures appended (a new object; the input is not mutated). */
export function withCodexDisclosures<T extends { downgrades: FleetAgentTaskContainmentDowngrade[] }>(
	record: T,
	extra: ReadonlyArray<FleetAgentTaskContainmentDowngrade | null>
): T {
	const entries = extra.filter((entry): entry is FleetAgentTaskContainmentDowngrade => entry !== null);
	if (entries.length === 0) return record;
	return { ...record, downgrades: [...record.downgrades, ...entries] };
}
