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
		return { vendor: classifyGpuVendor(text), model };
	}
	return null;
}
