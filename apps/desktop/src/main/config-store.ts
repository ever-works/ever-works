import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopConfig } from '../shared/ipc-contract';
import { DEFAULT_DESKTOP_MODE } from '../shared/ipc-contract';

export const DEFAULT_CONFIG: DesktopConfig = { wizardCompleted: false, mode: DEFAULT_DESKTOP_MODE };

/**
 * Load the desktop config JSON; corrupt or missing files fall back to defaults.
 * Configs written before client mode existed have no `mode` — they resolve to
 * the local stack, which is exactly what they were.
 */
export function loadConfig(filePath: string): DesktopConfig {
	try {
		const raw = fs.readFileSync(filePath, 'utf8');
		const parsed = JSON.parse(raw) as Partial<DesktopConfig>;
		const merged = { ...DEFAULT_CONFIG, ...parsed };
		if (merged.mode !== 'local-stack' && merged.mode !== 'remote-client') {
			merged.mode = DEFAULT_CONFIG.mode;
		}
		return merged;
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(filePath: string, config: DesktopConfig): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
}
