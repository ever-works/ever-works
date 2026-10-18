import type { CommandRunner } from './capabilities';

/**
 * GPU detection (audit A22).
 *
 * Before this, a node reported `os:`, `arch:`, `node:`, `docker`, `git`
 * and `display` — and nothing at all about whether the machine had an
 * accelerator. That is the single most expensive property a fleet
 * machine can have, and the scheduler had no way to see it: GPU work
 * either could not be targeted, or was targeted blind.
 *
 * The probe is deliberately cheap and never fatal. Every branch is
 * "ask a tool that is already there, believe it if it answers, shrug if
 * it does not" — a machine with no GPU, no probe tool, or a probe that
 * hangs simply reports no GPU rather than failing the heartbeat that
 * carries every other capability.
 */

/** Vendors we classify. `other` = a GPU we saw but could not attribute. */
export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';

export interface GpuInfo {
	vendor: GpuVendor;
	/** First adapter name the probe reported, trimmed. */
	model: string | null;
}

/** Ordered so 'intel' cannot shadow a discrete card listed alongside it. */
const VENDOR_PATTERNS: readonly { vendor: GpuVendor; pattern: RegExp }[] = [
	{ vendor: 'nvidia', pattern: /\b(nvidia|geforce|quadro|tesla|rtx|gtx)\b/i },
	{ vendor: 'amd', pattern: /\b(amd|radeon|firepro|instinct)\b/i },
	{ vendor: 'apple', pattern: /\bapple\s+m\d|\bapple\s+gpu\b/i },
	{ vendor: 'intel', pattern: /\b(intel|iris|uhd graphics|hd graphics)\b/i }
];

/** Attribute an adapter description to a vendor. */
export function classifyGpuVendor(text: string): GpuVendor {
	for (const { vendor, pattern } of VENDOR_PATTERNS) {
		if (pattern.test(text)) {
			return vendor;
		}
	}
	return 'other';
}

/** First non-empty line, trimmed and length-capped for a capability tag. */
export function firstAdapterLine(stdout: string): string | null {
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed) {
			return trimmed.slice(0, 120);
		}
	}
	return null;
}

/** One probe attempt: command + args, per platform. */
interface Probe {
	command: string;
	args: string[];
}

/** Probes to try in order for a platform, cheapest and most specific first. */
export function gpuProbesFor(platform: string): Probe[] {
	// `nvidia-smi` is present on every machine with a working NVIDIA
	// driver, on all three platforms, and answers in milliseconds.
	const nvidia: Probe = {
		command: 'nvidia-smi',
		args: ['--query-gpu=name', '--format=csv,noheader']
	};
	if (platform === 'win32') {
		return [
			nvidia,
			{
				command: 'powershell',
				args: [
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'
				]
			}
		];
	}
	if (platform === 'darwin') {
		return [
			nvidia,
			// The section header is always present, so only the
			// "Chipset Model:" values are read (see extractChipsetLines).
			{ command: 'system_profiler', args: ['SPDisplaysDataType'] }
		];
	}
	return [
		nvidia,
		// `lspci` output is one line per device; we only want display
		// controllers, and grep is not guaranteed, so filter in-process.
		{ command: 'lspci', args: [] }
	];
}

/** Keep only lines that describe a display adapter (Linux `lspci`). */
function extractDisplayLines(stdout: string): string {
	const lines = stdout
		.split(/\r?\n/)
		.filter((line) => /\b(vga compatible controller|3d controller|display controller)\b/i.test(line));
	return lines.join('\n');
}

/** Keep only the `Chipset Model:` values (macOS `system_profiler`). */
function extractChipsetLines(stdout: string): string {
	const lines: string[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const match = /chipset model:\s*(.+)$/i.exec(line);
		if (match) {
			lines.push(match[1].trim());
		}
	}
	return lines.join('\n');
}

/**
 * Detect a GPU on this host, or null.
 *
 * Never throws: an unspawnable probe, a nonzero exit and an empty
 * answer are all "no GPU detected". Capability detection runs on every
 * heartbeat, and a probe that could take the heartbeat down with it
 * would be a worse bug than the missing tag it was added to fix.
 */
export async function detectGpu(runner: CommandRunner, platform: string): Promise<GpuInfo | null> {
	return (await detectGpuWithEvidence(runner, platform)).gpu;
}

/**
 * {@link detectGpu}, plus whether ANY probe actually answered.
 *
 * The capability tag only needs "found one or not"; the health snapshot
 * (FL-03) needs to tell "no GPU" from "could not ask", because the first is
 * a fact it may show ("no GPU") and the second must render as "—". A probe
 * that ran and exited 0 without naming an adapter is an answer; a probe that
 * could not be spawned or failed is not.
 */
export async function detectGpuWithEvidence(
	runner: CommandRunner,
	platform: string
): Promise<{ gpu: GpuInfo | null; answered: boolean }> {
	let answered = false;
	for (const probe of gpuProbesFor(platform)) {
		let stdout: string;
		try {
			const result = await runner.run(probe.command, probe.args);
			if (result.code !== 0) {
				continue;
			}
			stdout = result.stdout ?? '';
		} catch {
			continue;
		}
		// `nvidia-smi` exiting 0 says only that THIS vendor's driver answered;
		// its silence about other vendors is not evidence of no GPU at all.
		if (probe.command !== 'nvidia-smi') answered = true;

		let text = stdout;
		if (probe.command === 'lspci') {
			text = extractDisplayLines(stdout);
		} else if (probe.command === 'system_profiler') {
			text = extractChipsetLines(stdout);
		}

		const model = firstAdapterLine(text);
		if (!model) {
			continue;
		}
		return { gpu: { vendor: classifyGpuVendor(text), model }, answered: true };
	}
	return { gpu: null, answered };
}

// ─── Utilisation and memory (computer health, FL-03) ────────────────────────

/** A GPU's live figures, where the vendor's own tool exposes them. Absent fields were not readable. */
export interface GpuUsageReading {
	utilPercent?: number;
	memUsedMiB?: number;
	memTotalMiB?: number;
}

/** The single `nvidia-smi` query that answers name, utilisation and memory in one spawn. */
export const NVIDIA_SMI_HEALTH_ARGS: readonly string[] = [
	'--query-gpu=name,utilization.gpu,memory.used,memory.total',
	'--format=csv,noheader,nounits'
];

function numericField(text: string | undefined): number | undefined {
	if (typeof text !== 'string') return undefined;
	const trimmed = text.trim();
	// `[N/A]`, `[Not Supported]` and empty cells are "not readable", not zero.
	if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
	const value = Number(trimmed);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * Parse `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total
 * --format=csv,noheader,nounits` — one line per GPU, e.g. `NVIDIA GeForce RTX 4070, 12, 2048, 8188`.
 * A name may itself contain commas, so the three numbers are read from the END of each line.
 * Lines that do not parse are skipped; an empty list means nothing parsed.
 */
export function parseNvidiaSmiHealth(stdout: string): Array<{ name: string } & GpuUsageReading> {
	const readings: Array<{ name: string } & GpuUsageReading> = [];
	for (const raw of (stdout ?? '').split(/\r?\n/)) {
		const reading = parseNvidiaSmiLine(raw.trim());
		if (reading) readings.push(reading);
	}
	return readings;
}

function parseNvidiaSmiLine(line: string): ({ name: string } & GpuUsageReading) | null {
	if (!line) return null;
	const cells = line.split(',');
	if (cells.length < 4) return null;
	const memTotal = numericField(cells[cells.length - 1]);
	const memUsed = numericField(cells[cells.length - 2]);
	const util = numericField(cells[cells.length - 3]);
	const name = cells
		.slice(0, cells.length - 3)
		.join(',')
		.trim()
		.slice(0, 120);
	if (!name) return null;
	const reading: { name: string } & GpuUsageReading = { name };
	if (util !== undefined) reading.utilPercent = util;
	if (memUsed !== undefined) reading.memUsedMiB = Math.round(memUsed);
	if (memTotal !== undefined) reading.memTotalMiB = Math.round(memTotal);
	return reading;
}

/** The `rocm-smi` query for an AMD card's use and VRAM, as JSON. */
export const ROCM_SMI_HEALTH_ARGS: readonly string[] = ['--showuse', '--showmeminfo', 'vram', '--json'];

/**
 * Parse `rocm-smi --showuse --showmeminfo vram --json` — `{ "card0": { "GPU use (%)": "3",
 * "VRAM Total Memory (B)": "17163091968", "VRAM Total Used Memory (B)": "251658240" } }`.
 * The first card only; keys matched by meaning, not exact spelling, because the tool's
 * wording has drifted between releases.
 */
export function parseRocmSmiHealth(stdout: string): GpuUsageReading | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse((stdout ?? '').trim());
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
	const card = Object.entries(parsed as Record<string, unknown>).find(([key]) => /^card\d+$/i.test(key))?.[1];
	if (!card || typeof card !== 'object') return null;
	const fields = Object.entries(card as Record<string, unknown>);
	const read = (pattern: RegExp): number | undefined => {
		const entry = fields.find(([key]) => pattern.test(key));
		return entry ? numericField(String(entry[1])) : undefined;
	};
	const util = read(/gpu use \(%\)/i);
	const totalBytes = read(/vram total memory \(b\)/i);
	const usedBytes = read(/vram total used memory \(b\)/i);
	const reading: GpuUsageReading = {};
	if (util !== undefined) reading.utilPercent = util;
	if (usedBytes !== undefined) reading.memUsedMiB = Math.round(usedBytes / (1024 * 1024));
	if (totalBytes !== undefined) reading.memTotalMiB = Math.round(totalBytes / (1024 * 1024));
	return Object.keys(reading).length > 0 ? reading : null;
}

/** The `ioreg` query whose `PerformanceStatistics` carry an Apple GPU's utilisation. */
export const IOREG_GPU_ARGS: readonly string[] = ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'];

/** Read `"Device Utilization %"=12` out of `ioreg -r -d 1 -w 0 -c IOAccelerator`; null when absent. */
export function parseIoregGpuUtil(stdout: string): number | null {
	const match = /"Device Utilization %"\s*=\s*(\d+)/.exec(stdout ?? '');
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}
