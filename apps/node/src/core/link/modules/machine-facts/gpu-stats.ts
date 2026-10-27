import type { FleetGpuView } from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import { classifyGpuVendor, detectGpu } from '../../../gpu-probe';
import { jsonScript, parseJsonList, POWERSHELL, powerShellArgs } from './powershell';

/**
 * Machine facts (FL-09, plan §3, spec FR-14) — the GPU strip above the
 * Processes list. Extends the vendor/model probe of `gpu-probe.ts` with what
 * each vendor's own tool reports:
 *
 *  - **NVIDIA** (all three OSes): `nvidia-smi --query-gpu=…` — name,
 *    utilisation, memory used and total, one line per GPU;
 *  - **AMD on Linux**: sysfs `gpu_busy_percent` and `mem_info_vram_*` per card;
 *  - **Apple**: `system_profiler SPDisplaysDataType -json` — model and the
 *    machine's shared memory; utilisation is NOT reported, so it is `null`,
 *    never 0 ("utilisation unavailable");
 *  - **Windows, other vendors**: `Win32_VideoController` model and adapter
 *    memory, utilisation `null`.
 *
 * Never fatal: a tool that is missing or fails yields fewer GPUs, not an
 * error, and the machine-wide probe answers last.
 */

export interface GpuStatsDeps {
	runner: CommandRunner;
	platform: string;
	/** Reads a small text file (sysfs); injected for tests. */
	readText?: (path: string) => Promise<string | null>;
	/** Lists `/sys/class/drm` entries; injected for tests. */
	listDir?: (path: string) => Promise<string[]>;
	/** Total memory of the machine, for Apple's shared memory. */
	totalMemBytes?: () => number;
}

const MIB = 1024 * 1024;

/** `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(stdout: string): FleetGpuView[] {
	const out: FleetGpuView[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const parts = line.split(',').map((part) => part.trim());
		if (parts.length < 4 || !parts[0]) continue;
		const number = (value: string): number | null => (/^\d+(\.\d+)?$/.test(value) ? Number(value) : null);
		const util = number(parts[1]);
		const used = number(parts[2]);
		const total = number(parts[3]);
		out.push({
			vendor: 'nvidia',
			model: parts[0].slice(0, 120),
			utilizationPercent: util,
			memUsedBytes: used === null ? null : used * MIB,
			memTotalBytes: total === null ? null : total * MIB
		});
	}
	return out;
}

/** `system_profiler SPDisplaysDataType -json` → Apple GPUs (model, cores) with shared memory and no utilisation. */
export function parseAppleDisplays(stdout: string, totalMemBytes: number | null): FleetGpuView[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	const list = (parsed as { SPDisplaysDataType?: unknown })?.SPDisplaysDataType;
	if (!Array.isArray(list)) return [];
	const out: FleetGpuView[] = [];
	for (const entry of list) {
		if (!entry || typeof entry !== 'object') continue;
		const raw = entry as Record<string, unknown>;
		const model =
			(typeof raw.sppci_model === 'string' && raw.sppci_model) ||
			(typeof raw._name === 'string' && raw._name) ||
			null;
		if (!model) continue;
		const vendor = classifyGpuVendor(model);
		const vram = typeof raw.spdisplays_vram === 'string' ? /(\d+)\s*(GB|MB)/i.exec(raw.spdisplays_vram) : null;
		const shared = vendor === 'apple' || !vram;
		out.push({
			vendor,
			model: model.slice(0, 120),
			utilizationPercent: null,
			memUsedBytes: null,
			memTotalBytes: vram
				? Number(vram[1]) * (vram[2].toUpperCase() === 'GB' ? 1024 * MIB : MIB)
				: shared
					? totalMemBytes
					: null,
			...(shared ? { sharedMemory: true } : {})
		});
	}
	return out;
}

const WINDOWS_SCRIPT = jsonScript(
	'Get-CimInstance -ClassName Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress -Depth 2'
);

export function parseWindowsVideoControllers(stdout: string): FleetGpuView[] {
	const out: FleetGpuView[] = [];
	for (const raw of parseJsonList(stdout)) {
		if (typeof raw.Name !== 'string' || !raw.Name) continue;
		out.push({
			vendor: classifyGpuVendor(raw.Name),
			model: raw.Name.slice(0, 120),
			utilizationPercent: null,
			memUsedBytes: null,
			// AdapterRAM is a uint32 and saturates at 4 GiB; a saturated value is not a fact.
			memTotalBytes:
				typeof raw.AdapterRAM === 'number' && raw.AdapterRAM > 0 && raw.AdapterRAM < 4294967295
					? raw.AdapterRAM
					: null
		});
	}
	return out;
}

async function amdSysfs(deps: GpuStatsDeps): Promise<FleetGpuView[]> {
	if (!deps.readText || !deps.listDir) return [];
	const cards = (await deps.listDir('/sys/class/drm').catch(() => [] as string[])).filter((entry) =>
		/^card\d+$/.test(entry)
	);
	const out: FleetGpuView[] = [];
	for (const card of cards.sort()) {
		const base = `/sys/class/drm/${card}/device`;
		const vendorId = (await deps.readText(`${base}/vendor`))?.trim();
		if (vendorId !== '0x1002') continue; // AMD
		const number = async (file: string): Promise<number | null> => {
			const text = (await deps.readText!(`${base}/${file}`))?.trim();
			return text && /^\d+$/.test(text) ? Number(text) : null;
		};
		out.push({
			vendor: 'amd',
			model: (await deps.readText(`${base}/product_name`))?.trim().slice(0, 120) || 'AMD GPU',
			utilizationPercent: await number('gpu_busy_percent'),
			memUsedBytes: await number('mem_info_vram_used'),
			memTotalBytes: await number('mem_info_vram_total')
		});
	}
	return out;
}

/** Every GPU this machine reports, with the stats its vendor's tool gives. */
export async function readGpus(deps: GpuStatsDeps): Promise<FleetGpuView[]> {
	const { runner, platform } = deps;
	const gpus: FleetGpuView[] = [];
	const nvidia = await runner
		.run(
			'nvidia-smi',
			['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
			{ timeoutMs: 5_000 }
		)
		.catch(() => null);
	if (nvidia && nvidia.code === 0) gpus.push(...parseNvidiaSmi(nvidia.stdout));

	if (platform === 'linux') {
		gpus.push(...(await amdSysfs(deps)));
	} else if (platform === 'darwin') {
		const result = await runner
			.run('system_profiler', ['SPDisplaysDataType', '-json'], { timeoutMs: 10_000 })
			.catch(() => null);
		if (result && result.code === 0) {
			const others = parseAppleDisplays(result.stdout, deps.totalMemBytes?.() ?? null).filter(
				(gpu) => gpu.vendor !== 'nvidia' || gpus.every((known) => known.model !== gpu.model)
			);
			gpus.push(...others);
		}
	} else if (platform === 'win32') {
		const result = await runner
			.run(POWERSHELL, powerShellArgs(WINDOWS_SCRIPT), { timeoutMs: 10_000 })
			.catch(() => null);
		if (result && result.code === 0) {
			// nvidia-smi already described its cards with live numbers; keep the rest.
			gpus.push(
				...parseWindowsVideoControllers(result.stdout).filter(
					(gpu) => gpu.vendor !== 'nvidia' || gpus.length === 0
				)
			);
		}
	}

	if (gpus.length === 0) {
		// Last resort: the heartbeat's own probe — a model, nothing more.
		const known = await detectGpu(runner, platform).catch(() => null);
		if (known) {
			gpus.push({
				vendor: known.vendor,
				model: known.model,
				utilizationPercent: null,
				memUsedBytes: null,
				memTotalBytes: null
			});
		}
	}
	return gpus.slice(0, 16);
}
