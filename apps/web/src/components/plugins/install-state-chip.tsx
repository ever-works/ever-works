/**
 * EW-693 / T34 — Reusable install-state chip.
 *
 * Renders the per-replica install lifecycle as a coloured pill so the
 * settings page (and any future surface — admin dashboard, CLI-style
 * panels) can show install state distinct from `enabled`.
 *
 * Pinned colour mapping (Tailwind class tokens consistent with the
 * rest of `apps/web`):
 *
 * - available  → neutral (grey)  — known in the catalog, not on disk.
 * - installing → blue + pulse    — pacote.extract in flight on this replica.
 * - installed  → green           — present and importable.
 * - error      → red             — last install failed; `error` carries the reason.
 *
 * The chip is self-contained — no API calls, no state. Consumers pass
 * an install row (typically from `pluginsAPI.getInstallStatus` or
 * embedded in `pluginsAPI.getCatalog().entries[i].install`) and the
 * chip renders.
 */

import type { PluginInstallStateDto } from '@/lib/api/plugins';

interface PluginInstallStateChipProps {
	readonly install: PluginInstallStateDto;
	/**
	 * When true, the `installedVersion` is appended as a secondary
	 * line (e.g. `installed · 1.2.0`). Useful in the catalog table;
	 * usually off for inline button context.
	 */
	readonly showVersion?: boolean;
}

const TONE: Record<PluginInstallStateDto['installState'], { bg: string; text: string; label: string }> = {
	available: {
		bg: 'bg-gray-100 dark:bg-gray-800',
		text: 'text-gray-700 dark:text-gray-300',
		label: 'Available'
	},
	installing: {
		bg: 'bg-blue-100 dark:bg-blue-900/40 animate-pulse',
		text: 'text-blue-800 dark:text-blue-200',
		label: 'Installing…'
	},
	installed: {
		bg: 'bg-green-100 dark:bg-green-900/40',
		text: 'text-green-800 dark:text-green-200',
		label: 'Installed'
	},
	error: {
		bg: 'bg-red-100 dark:bg-red-900/40',
		text: 'text-red-800 dark:text-red-200',
		label: 'Install failed'
	}
};

export function PluginInstallStateChip({ install, showVersion = false }: PluginInstallStateChipProps) {
	const tone = TONE[install.installState] ?? TONE.available;

	return (
		<span
			role="status"
			aria-label={`Install state: ${tone.label}`}
			title={install.installError || tone.label}
			className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone.bg} ${tone.text}`}
		>
			<span>{tone.label}</span>
			{showVersion && install.installedVersion ? (
				<span aria-hidden className="opacity-70">
					· {install.installedVersion}
				</span>
			) : null}
		</span>
	);
}
