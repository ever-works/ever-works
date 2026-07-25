import { Menu, Tray, nativeImage } from 'electron';

// Tiny generated 16x16 indigo square — placeholder until branded icons land
// with the packaging/signing milestone.
const TRAY_ICON_DATA_URL =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIElEQVR4nGPwd3vaQwlmgDL+k4lHDRg1YNQAahtANgYAJXBeK1To2JkAAAAASUVORK5CYII=';

export interface TrayHandlers {
	onShow(): void;
	onStartServices(): void;
	onStopServices(): void;
	onQuit(): void;
}

export function createTray(handlers: TrayHandlers): Tray {
	const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
	const tray = new Tray(icon);
	tray.setToolTip('Ever Works Desktop');
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: 'Open Ever Works', click: () => handlers.onShow() },
			{ type: 'separator' },
			{ label: 'Start services', click: () => handlers.onStartServices() },
			{ label: 'Stop services', click: () => handlers.onStopServices() },
			{ type: 'separator' },
			{ label: 'Quit', click: () => handlers.onQuit() }
		])
	);
	tray.on('click', () => handlers.onShow());
	return tray;
}
