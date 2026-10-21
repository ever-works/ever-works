import { redactSecrets, type FleetLinkOperationProgressValue, type FleetRunRequest } from '@ever-works/contracts';

/**
 * Machine facts (FL-09 P2) — the pure parts of Docker's long acts: the
 * argv of a run (values through the environment only, FR-29), the pull
 * percentage from Docker's layer lines, the prune summary, and the redaction
 * every output line goes through before it leaves the machine.
 */

/**
 * The argv of `docker run` for a validated request. Every environment
 * variable is passed as `-e NAME` WITHOUT a value: Docker reads the value from
 * its own environment, which is where the caller puts it — so no value is
 * ever on a command line (`ps`, audit, logs). The image comes last before the
 * command, and nothing here is a free-form flag.
 */
export function dockerRunArgv(request: FleetRunRequest): { args: string[]; env: Record<string, string> } {
	const args = ['run', '-d'];
	const env: Record<string, string> = {};
	if (request.name) args.push('--name', request.name);
	for (const port of request.ports) {
		args.push('-p', `${port.host}:${port.container}/${port.proto ?? 'tcp'}`);
	}
	for (const variable of request.env) {
		args.push('-e', variable.name);
		env[variable.name] = variable.value;
	}
	for (const volume of request.volumes) {
		args.push('--mount', mountSpec(volume.source, volume.target, volume.readOnly === true));
	}
	if (request.restart !== 'no') args.push('--restart', request.restart);
	args.push(request.image, ...(request.command ?? []));
	return { args, env };
}

/**
 * `--mount` rather than `-v`: key=value pairs, so a path can never be split
 * into an option. A host path is a `bind`, anything else a named `volume`.
 */
export function mountSpec(source: string, target: string, readOnly: boolean): string {
	const bind = source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source) || source.startsWith('\\\\');
	return [`type=${bind ? 'bind' : 'volume'}`, `source=${source}`, `target=${target}`, ...(readOnly ? ['readonly'] : [])].join(',');
}

/** A line of operation output as it may leave the machine: secrets scanned, run values masked, cut. */
export function safeOutputLine(line: string, maskedValues: readonly string[] = []): string {
	let out = line;
	for (const value of maskedValues) {
		if (value.length >= 3) out = out.split(value).join('…');
	}
	return redactSecrets(out).cleaned.slice(0, 500);
}

const SIZE_UNITS: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

function size(value: string, unit: string): number | null {
	const factor = SIZE_UNITS[unit];
	const amount = Number(value);
	return factor && Number.isFinite(amount) ? amount * factor : null;
}

/**
 * Docker's pull output → a percentage across every layer it has named:
 * `a2abf6c4d29d: Downloading [=====>   ] 12.3MB/41MB`, `… Pull complete`,
 * `… Already exists`. Layers without a size yet count as not started.
 */
export function createPullProgress(): (line: string) => FleetLinkOperationProgressValue | null {
	const layers = new Map<string, { current: number; total: number; done: boolean }>();
	return (line) => {
		const match = /^([a-f0-9]{12}): (.*)$/.exec(line.trim());
		if (!match) {
			return /^(Digest|Status):/.test(line.trim()) ? { message: line.trim().slice(0, 300) } : null;
		}
		const [, layer, rest] = match;
		const entry = layers.get(layer) ?? { current: 0, total: 0, done: false };
		const bytes = /(Downloading|Extracting)\s.*?([\d.]+)\s*([kKMGT]?i?B)\/([\d.]+)\s*([kKMGT]?i?B)/.exec(rest);
		if (bytes) {
			const current = size(bytes[2], bytes[3]);
			const total = size(bytes[4], bytes[5]);
			if (current !== null && total !== null && total > 0) {
				// Extracting counts as the second half of the layer's work.
				const extracting = bytes[1] === 'Extracting';
				entry.total = total * 2;
				entry.current = extracting ? total + current : current;
			}
		} else if (/Pull complete|Already exists|Download complete/.test(rest)) {
			if (/Pull complete|Already exists/.test(rest)) entry.done = true;
		}
		layers.set(layer, entry);
		let current = 0;
		let total = 0;
		for (const value of layers.values()) {
			if (value.done) {
				const whole = value.total || 1;
				current += whole;
				total += whole;
			} else {
				current += value.current;
				total += value.total || 1;
			}
		}
		const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : undefined;
		return { ...(percent !== undefined ? { percent } : {}), message: line.trim().slice(0, 300) };
	};
}

/** `Total reclaimed space: 1.6GB` → bytes; the deleted image count from `deleted:` / `untagged:` lines. */
export function parsePruneSummary(lines: readonly string[]): { reclaimedBytes: number; removedCount: number } {
	let reclaimedBytes = 0;
	let removedCount = 0;
	for (const line of lines) {
		const total = /Total reclaimed space:\s*([\d.]+)\s*([kKMGT]?i?B)/.exec(line);
		if (total) reclaimedBytes = Math.round(size(total[1], total[2]) ?? 0);
		if (/^deleted:\s*sha256:/i.test(line.trim())) removedCount += 1;
	}
	return { reclaimedBytes, removedCount };
}
