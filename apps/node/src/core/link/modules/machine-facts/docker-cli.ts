import {
	asFleetContainerState,
	FLEET_CONTAINER_ACTION_BASE_CLASS,
	type FleetContainerAction,
	type FleetContainerPort,
	type FleetContainerView,
	type FleetDockerStatus,
	type FleetImageView
} from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import { firstLine } from './exec';

/**
 * Machine facts (FL-09 P2, plan §3, spec FR-25) — Docker through its
 * command-line tool ONLY. The `docker` binary is found on PATH; nothing here
 * opens, names or mounts the daemon's socket. Every read asks for
 * `--format '{{json .}}'` (one JSON object per line), which Docker Engine and
 * Docker Desktop print the same way; unknown fields are ignored.
 */

export const DOCKER = 'docker';

/** One JSON object per line → the objects (a line that is not JSON is skipped). */
export function parseJsonLines(stdout: string): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
				out.push(parsed as Record<string, unknown>);
		} catch {
			// not JSON: skip
		}
	}
	return out;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** `412MB`, `1.1GB`, `512kB`, `180MiB` → bytes (decimal units as Docker prints them; binary for `iB`). */
export function parseDockerSize(value: string): number | null {
	const match = /^\s*([\d.]+)\s*([kKMGTP]?i?B)\s*$/.exec(value);
	if (!match) return null;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount)) return null;
	const unit = match[2];
	const binary = unit.includes('i');
	const base = binary ? 1024 : 1000;
	const power = { B: 0, k: 1, K: 1, M: 2, G: 3, T: 4, P: 5 }[unit[0] as 'B'] ?? 0;
	return Math.round(amount * base ** power);
}

/** `2.00%` → 2. */
export function parseDockerPercent(value: string): number | null {
	const match = /^\s*([\d.]+)\s*%\s*$/.exec(value);
	return match ? Number(match[1]) : null;
}

/** `2026-10-21 09:00:00 +0000 UTC` → ISO; anything else → null. */
export function parseDockerTime(value: string): string | null {
	const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2})/.exec(value.trim());
	if (!match) return null;
	const at = Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
	return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * Docker's `Ports` column: `0.0.0.0:3000->3000/tcp, :::3000->3000/tcp, 5432/tcp`.
 * The IPv6 twin of an IPv4 publish is folded into one row.
 */
export function parseDockerPorts(value: string): FleetContainerPort[] {
	const out: FleetContainerPort[] = [];
	const seen = new Set<string>();
	for (const raw of value.split(',')) {
		const part = raw.trim();
		if (!part) continue;
		const published = /^(.*):(\d+)(?:-\d+)?->(\d+)(?:-\d+)?\/(tcp|udp|sctp)$/.exec(part);
		if (published) {
			const hostPort = Number(published[2]);
			const containerPort = Number(published[3]);
			const proto = published[4] as FleetContainerPort['proto'];
			const key = `${hostPort}:${containerPort}/${proto}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ hostIp: published[1] || null, hostPort, containerPort, proto });
			continue;
		}
		const exposed = /^(\d+)(?:-\d+)?\/(tcp|udp|sctp)$/.exec(part);
		if (exposed) {
			const key = `-:${exposed[1]}/${exposed[2]}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				hostIp: null,
				hostPort: null,
				containerPort: Number(exposed[1]),
				proto: exposed[2] as FleetContainerPort['proto']
			});
		}
	}
	return out;
}

/** `com.docker.compose.project=acme,com.docker.compose.service=api` → a map. */
export function parseDockerLabels(value: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const part of value.split(',')) {
		const at = part.indexOf('=');
		if (at > 0) out.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
	}
	return out;
}

/** The acts a container's state allows: start when stopped; stop / restart while running; remove once not running. */
export function containerActions(state: FleetContainerView['state']): FleetContainerAction[] {
	if (state === 'running' || state === 'restarting' || state === 'paused') return ['stop', 'restart'];
	if (state === 'removing') return [];
	return ['start', 'remove'];
}

/** `docker ps -a --no-trunc --format '{{json .}}'` rows (stats merged by the caller). */
export function parseContainers(stdout: string): FleetContainerView[] {
	const out: FleetContainerView[] = [];
	for (const row of parseJsonLines(stdout)) {
		const id = text(row.ID).slice(0, 12);
		if (!/^[a-f0-9]{12}$/.test(id)) continue;
		const state = asFleetContainerState(row.State);
		const labels = parseDockerLabels(text(row.Labels));
		const actions = containerActions(state);
		const confirmation: FleetContainerView['confirmation'] = {};
		for (const action of actions) confirmation[action] = FLEET_CONTAINER_ACTION_BASE_CLASS[action];
		out.push({
			id,
			name: text(row.Names).split(',')[0]?.replace(/^\//, '') || id,
			image: text(row.Image),
			state,
			status: text(row.Status),
			ports: parseDockerPorts(text(row.Ports)),
			createdAt: parseDockerTime(text(row.CreatedAt)),
			composeProject: labels.get('com.docker.compose.project') ?? null,
			composeService: labels.get('com.docker.compose.service') ?? null,
			cpuPercent: null,
			memBytes: null,
			isNode: labels.get('works.ever.fleet.node') === 'true',
			actions,
			confirmation
		});
	}
	return out;
}

/** `docker stats --no-stream --no-trunc --format '{{json .}}'` → CPU and memory by short id. */
export function parseStats(stdout: string): Map<string, { cpuPercent: number | null; memBytes: number | null }> {
	const out = new Map<string, { cpuPercent: number | null; memBytes: number | null }>();
	for (const row of parseJsonLines(stdout)) {
		const id = text(row.ID).slice(0, 12);
		if (!id) continue;
		const used = text(row.MemUsage).split('/')[0] ?? '';
		out.set(id, { cpuPercent: parseDockerPercent(text(row.CPUPerc)), memBytes: parseDockerSize(used) });
	}
	return out;
}

/** `docker images --no-trunc --format '{{json .}}'` → images (in-use counts filled by the caller). */
export function parseImages(stdout: string): FleetImageView[] {
	const byId = new Map<string, FleetImageView>();
	for (const row of parseJsonLines(stdout)) {
		const id = text(row.ID)
			.replace(/^sha256:/, '')
			.slice(0, 12);
		if (!/^[a-f0-9]{12}$/.test(id)) continue;
		const repo = text(row.Repository);
		const tag = text(row.Tag);
		const name = repo && repo !== '<none>' ? (tag && tag !== '<none>' ? `${repo}:${tag}` : repo) : null;
		const existing = byId.get(id);
		if (existing) {
			if (name && !existing.repoTags.includes(name)) existing.repoTags.push(name);
			continue;
		}
		byId.set(id, {
			id,
			repoTags: name ? [name] : [],
			sizeBytes: parseDockerSize(text(row.Size)),
			createdAt: parseDockerTime(text(row.CreatedAt)),
			inUseBy: 0
		});
	}
	return [...byId.values()];
}

/** How many containers use each image: matched by `repo:tag` (or `repo` = `repo:latest`) or by id prefix. */
export function countImageUse(images: FleetImageView[], containerImages: readonly string[]): FleetImageView[] {
	return images.map((image) => {
		const names = new Set(
			image.repoTags.flatMap((tag) => (tag.endsWith(':latest') ? [tag, tag.slice(0, -7)] : [tag]))
		);
		const inUseBy = containerImages.filter((ref) => {
			const bare = ref.replace(/^sha256:/, '');
			return names.has(ref) || (bare.length >= 12 && image.id.startsWith(bare.slice(0, 12)));
		}).length;
		return { ...image, inUseBy };
	});
}

/** Whether Docker is installed and its daemon answers (U6, U7). */
export async function dockerStatus(runner: CommandRunner): Promise<FleetDockerStatus> {
	const result = await runner.run(DOCKER, ['version', '--format', '{{json .}}'], { timeoutMs: 10_000 });
	if (result.spawnError === 'ENOENT') return { installed: false, daemonRunning: false, version: null };
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
	} catch {
		parsed = null;
	}
	const server =
		parsed && typeof parsed.Server === 'object' && parsed.Server
			? (parsed.Server as Record<string, unknown>)
			: null;
	if (result.code === 0 && server) {
		return {
			installed: true,
			daemonRunning: true,
			version: typeof server.Version === 'string' ? server.Version : null
		};
	}
	return {
		installed: true,
		daemonRunning: false,
		version: null,
		message: firstLine(result.stderr, 'the Docker daemon did not answer')
	};
}
