import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	isFleetActionsRunnerMode,
	isFleetActionsRunnerName,
	isFleetActionsRunnerScope,
	type FleetActionsRunnerMode,
	type FleetActionsRunnerScope
} from '@ever-works/contracts';

/**
 * Actions runners on computers (FL-18, plan §6.1 `runner-state.ts`) — what
 * the node keeps about its runners, under its runners folder
 * (`<config dir>/actions-runners`, owner-only, spec FR-10):
 *
 *   <root>/<name>/                    the runner's own folder (GitHub's build, extracted)
 *   <root>/<name>/ever-works.json     runner id, name, target, labels, mode, version, service unit
 *   <root>/<name>/.runner             written by the runner's config (its GitHub id)
 *   <root>/<name>/.service            written by its service install (the unit / label / service name)
 *   <root>/<name>/_diag/Runner_*.log  its diagnostic logs (FL-08 source `runner:<name>`)
 *   <root>/.downloads/<file>          the archive while it is downloaded and verified
 *
 * Never a token. Every path is built from a validated runner name, so nothing
 * outside `<root>/<name>/` is ever written or removed for a runner.
 */

export interface RunnerMeta {
	runnerId: string;
	name: string;
	scope: FleetActionsRunnerScope;
	target: string;
	labels: string[];
	mode: FleetActionsRunnerMode;
	runnerVersion: string | null;
	/** The archive's SHA-256 that was verified before extraction. */
	sha256: string | null;
	/** Set once `config` registered it. */
	configured: boolean;
	serviceUnit: string | null;
	installedAt: string | null;
}

export const RUNNER_META_FILE = 'ever-works.json';
export const RUNNER_DOWNLOADS_DIR = '.downloads';

export class RunnerState {
	constructor(readonly root: string) {}

	/** `<root>/<name>`; throws for anything that is not a runner name (never a path a caller shaped). */
	dir(name: string): string {
		if (!isFleetActionsRunnerName(name)) throw new Error('not a runner name');
		return join(this.root, name);
	}

	downloadsDir(): string {
		return join(this.root, RUNNER_DOWNLOADS_DIR);
	}

	/** Create the runners folder (owner-only on Unix) and one runner's folder in it. */
	async prepare(name: string): Promise<string> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		await chmod(this.root, 0o700).catch(() => undefined);
		const dir = this.dir(name);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(dir, 0o700).catch(() => undefined);
		return dir;
	}

	async readMeta(name: string): Promise<RunnerMeta | null> {
		let raw: string;
		try {
			raw = await readFile(join(this.dir(name), RUNNER_META_FILE), 'utf8');
		} catch {
			return null;
		}
		return parseRunnerMeta(raw);
	}

	async writeMeta(meta: RunnerMeta): Promise<void> {
		const dir = await this.prepare(meta.name);
		await writeFile(join(dir, RUNNER_META_FILE), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
	}

	/** Every runner folder that carries our meta file. */
	async list(): Promise<RunnerMeta[]> {
		let names: string[];
		try {
			names = await readdir(this.root);
		} catch {
			return [];
		}
		const out: RunnerMeta[] = [];
		for (const name of names) {
			if (!isFleetActionsRunnerName(name)) continue;
			const meta = await this.readMeta(name);
			if (meta) out.push(meta);
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	async findById(runnerId: string): Promise<RunnerMeta | null> {
		return (await this.list()).find((meta) => meta.runnerId === runnerId) ?? null;
	}

	/** GitHub's runner id from the runner's own `.runner` file (JSON, sometimes with a BOM). */
	async githubRunnerId(name: string): Promise<number | null> {
		const raw = await readFile(join(this.dir(name), '.runner'), 'utf8').catch(() => null);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw.replace(/^﻿/, '')) as { agentId?: unknown };
			const id = typeof parsed.agentId === 'number' ? parsed.agentId : Number(parsed.agentId);
			return Number.isSafeInteger(id) && id > 0 ? id : null;
		} catch {
			return null;
		}
	}

	/** The unit / plist / service name the runner's service install wrote (`.service`). */
	async serviceFile(name: string): Promise<string | null> {
		const raw = await readFile(join(this.dir(name), '.service'), 'utf8').catch(() => null);
		const value = raw?.replace(/^﻿/, '').trim() ?? '';
		return value && value.length < 400 && !value.includes('\n') ? value : null;
	}

	async exists(path: string): Promise<boolean> {
		return stat(path).then(
			() => true,
			() => false
		);
	}

	/** Remove one runner's folder and everything in it; missing is success. */
	async remove(name: string): Promise<void> {
		await rm(this.dir(name), { recursive: true, force: true });
	}
}

/** Our meta file, validated (a hand-edited or truncated file reads as absent). */
export function parseRunnerMeta(raw: string): RunnerMeta | null {
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	if (typeof value.runnerId !== 'string' || !isFleetActionsRunnerName(value.name)) return null;
	if (!isFleetActionsRunnerScope(value.scope) || typeof value.target !== 'string') return null;
	return {
		runnerId: value.runnerId,
		name: value.name,
		scope: value.scope,
		target: value.target,
		labels: Array.isArray(value.labels)
			? value.labels.filter((label): label is string => typeof label === 'string')
			: [],
		mode: isFleetActionsRunnerMode(value.mode) ? value.mode : 'service',
		runnerVersion: typeof value.runnerVersion === 'string' ? value.runnerVersion : null,
		sha256: typeof value.sha256 === 'string' ? value.sha256 : null,
		configured: value.configured === true,
		serviceUnit: typeof value.serviceUnit === 'string' ? value.serviceUnit : null,
		installedAt: typeof value.installedAt === 'string' ? value.installedAt : null
	};
}
