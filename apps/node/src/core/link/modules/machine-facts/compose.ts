import { dirname } from 'node:path';
import {
	asFleetContainerState,
	type FleetComposeAction,
	type FleetComposeHealth,
	type FleetComposeProjectView,
	type FleetComposeServiceView,
	type FleetContainerPort
} from '@ever-works/contracts';
import { parseJsonLines } from './docker-cli';

/**
 * Machine facts (FL-09 P3, plan §3, spec §4.5) — Compose projects through
 * `docker compose` (Compose v2, the Docker CLI plugin). Three reads merged
 * into one description: `compose ls` (the projects and their config files),
 * `compose config` (services, `depends_on`, ports, networks, volumes — needs
 * the files) and `compose ps` (each service's container, state and health —
 * works from the containers' labels even when the files are gone, U14).
 *
 * The config files are ALWAYS the ones Compose itself reported for the
 * project; a request names a project, never a path. `down` never passes `-v`:
 * named volumes are never removed from here (FR-34).
 */

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** `compose ls --all --format json` → name, status, config files. */
export function parseComposeLs(stdout: string): { name: string; status: string; configFiles: string[] }[] {
	let rows: unknown;
	try {
		rows = JSON.parse(stdout.trim() || '[]');
	} catch {
		rows = parseJsonLines(stdout);
	}
	if (!Array.isArray(rows)) return [];
	const out: { name: string; status: string; configFiles: string[] }[] = [];
	for (const entry of rows) {
		if (!entry || typeof entry !== 'object') continue;
		const raw = entry as Record<string, unknown>;
		const name = text(raw.Name);
		if (!name) continue;
		out.push({
			name,
			status: text(raw.Status),
			configFiles: text(raw.ConfigFiles)
				.split(',')
				.map((file) => file.trim())
				.filter(Boolean)
		});
	}
	return out;
}

/** `running(3)`, `exited(1), running(2)` → how many run, and how many in all. */
export function composeCounts(status: string): { running: number; total: number } {
	let running = 0;
	let total = 0;
	for (const match of status.matchAll(/([a-z]+)\((\d+)\)/g)) {
		const count = Number(match[2]);
		total += count;
		if (match[1] === 'running') running += count;
	}
	return { running, total };
}

/** The acts a project allows: every act with its files, only Down without them (U14). */
export function composeActions(filesMissing: boolean): FleetComposeAction[] {
	return filesMissing ? ['down'] : ['up', 'down', 'restart', 'pull'];
}

export function projectView(
	row: { name: string; status: string; configFiles: string[] },
	fileExists: (path: string) => boolean
): FleetComposeProjectView {
	const counts = composeCounts(row.status);
	const filesMissing = row.configFiles.length === 0 || row.configFiles.some((file) => !fileExists(file));
	return {
		name: row.name,
		status: row.status,
		serviceCount: counts.total,
		runningCount: counts.running,
		configFiles: row.configFiles,
		filesMissing,
		actions: composeActions(filesMissing)
	};
}

/** The project-file flags of a compose call: every config file plus the project directory. */
export function composeFileArgs(configFiles: readonly string[]): string[] {
	if (configFiles.length === 0) return [];
	const args: string[] = [];
	for (const file of configFiles) args.push('-f', file);
	args.push('--project-directory', dirname(configFiles[0]));
	return args;
}

/** The argv of one project act (FR-32, FR-34). */
export function composeActionArgs(
	project: string,
	configFiles: readonly string[],
	action: FleetComposeAction,
	service?: string
): string[] {
	const files = composeFileArgs(configFiles);
	const target = service ? [service] : [];
	switch (action) {
		case 'up':
			return ['compose', '-p', project, ...files, 'up', '-d', ...target];
		case 'down':
			// Never `-v`: named volumes stay (FR-34). Works from the labels when the files are gone.
			return ['compose', '-p', project, ...files, 'down'];
		case 'restart':
			return ['compose', '-p', project, ...files, 'restart', ...target];
		case 'pull':
			return ['compose', '-p', project, ...files, 'pull', ...target];
	}
}

interface ConfigService {
	name: string;
	image: string | null;
	dependsOn: FleetComposeServiceView['dependsOn'];
	ports: FleetContainerPort[];
	networks: string[];
	volumes: string[];
	mounts: string[];
}

/** `compose config --format json` → services with their dependencies, ports, networks and mounts. */
export function parseComposeConfig(stdout: string): {
	services: ConfigService[];
	networks: string[];
	volumes: string[];
} {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(stdout) as Record<string, unknown>;
	} catch {
		return { services: [], networks: [], volumes: [] };
	}
	const services: ConfigService[] = [];
	const raw =
		parsed.services && typeof parsed.services === 'object' ? (parsed.services as Record<string, unknown>) : {};
	for (const [name, value] of Object.entries(raw)) {
		const service = (value ?? {}) as Record<string, unknown>;
		const dependsOn: ConfigService['dependsOn'] = [];
		const depends = service.depends_on;
		if (Array.isArray(depends)) {
			for (const entry of depends)
				if (typeof entry === 'string') dependsOn.push({ service: entry, condition: 'service_started' });
		} else if (depends && typeof depends === 'object') {
			for (const [other, spec] of Object.entries(depends as Record<string, unknown>)) {
				const condition = text((spec as Record<string, unknown> | null)?.condition);
				dependsOn.push({
					service: other,
					condition:
						condition === 'service_healthy' || condition === 'service_completed_successfully'
							? condition
							: 'service_started'
				});
			}
		}
		const ports: FleetContainerPort[] = [];
		for (const entry of Array.isArray(service.ports) ? service.ports : []) {
			const port = (entry ?? {}) as Record<string, unknown>;
			const target = Number(port.target);
			if (!Number.isInteger(target)) continue;
			const published = Number(port.published);
			ports.push({
				hostIp: text(port.host_ip) || null,
				hostPort: Number.isInteger(published) && published > 0 ? published : null,
				containerPort: target,
				proto: port.protocol === 'udp' ? 'udp' : 'tcp'
			});
		}
		const networks =
			service.networks && typeof service.networks === 'object'
				? Object.keys(service.networks as Record<string, unknown>)
				: [];
		const volumes: string[] = [];
		const mounts: string[] = [];
		for (const entry of Array.isArray(service.volumes) ? service.volumes : []) {
			const volume = (entry ?? {}) as Record<string, unknown>;
			const source = text(volume.source);
			if (!source) continue;
			if (volume.type === 'volume') volumes.push(source);
			else if (volume.type === 'bind') mounts.push(source);
		}
		services.push({ name, image: text(service.image) || null, dependsOn, ports, networks, volumes, mounts });
	}
	const keys = (value: unknown) =>
		value && typeof value === 'object' ? Object.keys(value as Record<string, unknown>) : [];
	return { services, networks: keys(parsed.networks), volumes: keys(parsed.volumes) };
}

interface PsRow {
	service: string;
	id: string;
	name: string;
	image: string;
	state: ReturnType<typeof asFleetContainerState>;
	health: FleetComposeHealth;
	ports: FleetContainerPort[];
}

/** `compose ps -a --format json` (a JSON array before Compose 2.21, JSON lines after). */
export function parseComposePs(stdout: string): PsRow[] {
	let rows: unknown;
	try {
		rows = JSON.parse(stdout.trim() || '[]');
	} catch {
		rows = parseJsonLines(stdout);
	}
	if (!Array.isArray(rows)) rows = parseJsonLines(stdout);
	const out: PsRow[] = [];
	for (const entry of rows as unknown[]) {
		if (!entry || typeof entry !== 'object') continue;
		const raw = entry as Record<string, unknown>;
		const service = text(raw.Service);
		if (!service) continue;
		const health = text(raw.Health).toLowerCase();
		const ports: FleetContainerPort[] = [];
		for (const publisher of Array.isArray(raw.Publishers) ? raw.Publishers : []) {
			const value = (publisher ?? {}) as Record<string, unknown>;
			const target = Number(value.TargetPort);
			if (!Number.isInteger(target) || target <= 0) continue;
			const published = Number(value.PublishedPort);
			const key = `${published}:${target}`;
			if (ports.some((port) => `${port.hostPort}:${port.containerPort}` === key)) continue;
			ports.push({
				hostIp: text(value.URL) || null,
				hostPort: Number.isInteger(published) && published > 0 ? published : null,
				containerPort: target,
				proto: value.Protocol === 'udp' ? 'udp' : 'tcp'
			});
		}
		out.push({
			service,
			id: text(raw.ID).slice(0, 12),
			name: text(raw.Name),
			image: text(raw.Image),
			state: asFleetContainerState(raw.State),
			health: health === 'healthy' || health === 'unhealthy' || health === 'starting' ? health : null,
			ports
		});
	}
	return out;
}

/** Merge the config and the containers into the picture's services (config order; ps-only services appended). */
export function mergeComposeServices(
	config: ReturnType<typeof parseComposeConfig>,
	ps: readonly PsRow[],
	stats: ReadonlyMap<string, { cpuPercent: number | null; memBytes: number | null }>
): FleetComposeServiceView[] {
	const byService = new Map<string, PsRow>();
	for (const row of ps) if (!byService.has(row.service)) byService.set(row.service, row);
	const names = [...config.services.map((service) => service.name)];
	for (const row of ps) if (!names.includes(row.service)) names.push(row.service);
	return names.map((name) => {
		const declared = config.services.find((service) => service.name === name);
		const container = byService.get(name);
		const running = container?.state === 'running';
		const live = container && running ? stats.get(container.id) : undefined;
		return {
			name,
			image: declared?.image ?? container?.image ?? null,
			state: container ? container.state : 'absent',
			health: container?.health ?? null,
			containerId: container?.id || null,
			containerName: container?.name || null,
			cpuPercent: live?.cpuPercent ?? null,
			memBytes: live?.memBytes ?? null,
			ports: container && container.ports.length > 0 ? container.ports : (declared?.ports ?? []),
			networks: declared?.networks ?? [],
			volumes: declared?.volumes ?? [],
			mounts: declared?.mounts ?? [],
			dependsOn: declared?.dependsOn ?? []
		};
	});
}
