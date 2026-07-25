import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopConfig } from '../shared/ipc-contract';

export const DEFAULT_CONFIG: DesktopConfig = { wizardCompleted: false };

/** Load the desktop config JSON; corrupt or missing files fall back to defaults. */
export function loadConfig(filePath: string): DesktopConfig {
	try {
		const raw = fs.readFileSync(filePath, 'utf8');
		const parsed = JSON.parse(raw) as Partial<DesktopConfig>;
		return { ...DEFAULT_CONFIG, ...parsed };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(filePath: string, config: DesktopConfig): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(config, null, '\t')}\n`, 'utf8');
}
