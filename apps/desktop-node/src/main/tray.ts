import { Menu, Tray, nativeImage } from 'electron';
import type { ConnectionStatusView } from '../shared/ipc-contract';
import { describeStatus, isLive } from '../shared/status-label';

// Tiny generated 16x16 indigo square — placeholder until branded icons land
// with the packaging/signing milestone.
const TRAY_ICON_DATA_URL =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIElEQVR4nGPwd3vaQwlmgDL+k4lHDRg1YNQAahtANgYAJXBeK1To2JkAAAAASUVORK5CYII=';

export interface TrayHandlers {
	onShow(): void;
	onConnect(): void;
	onDisconnect(): void;
	onQuit(): void;
}

export interface NodeTray {
	tray: Tray;
	/** Reflect the live connection state in the tooltip and menu. */
	update(status: ConnectionStatusView): void;
}

export function createTray(handlers: TrayHandlers): NodeTray {
	const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
	const tray = new Tray(icon);

	const render = (status?: ConnectionStatusView): void => {
		const summary = status ? describeStatus(status) : 'Not connected';
		const connected = isLive(status);
		tray.setToolTip(`Ever Works Desktop Node — ${summary}`);
		tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: `Status: ${summary}`, enabled: false },
				{ type: 'separator' },
				{ label: 'Open Desktop Node', click: () => handlers.onShow() },
				{ type: 'separator' },
				{ label: 'Connect', enabled: !connected, click: () => handlers.onConnect() },
				{ label: 'Disconnect', enabled: connected, click: () => handlers.onDisconnect() },
				{ type: 'separator' },
				{ label: 'Quit', click: () => handlers.onQuit() }
			])
		);
	};

	render();
	tray.on('click', () => handlers.onShow());

	return { tray, update: render };
}
