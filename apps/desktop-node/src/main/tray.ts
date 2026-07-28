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
	/** Stop leasing new work without disconnecting (A18). */
	onPause(): void;
	/** Resume leasing after a pause (A18). */
	onResume(): void;
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
		const paused = status?.worker.paused === true;
		const active = status?.worker.activeJobCount ?? 0;
		// The tray is where an operator reaches for "stop taking work, now" —
		// so it says what the node is actually doing, not just whether it is
		// connected.
		const workLine = paused
			? active > 0
				? `Work: paused (finishing ${active})`
				: 'Work: paused'
			: active > 0
				? `Work: running ${active}`
				: 'Work: idle';
		tray.setToolTip(`Ever Works Desktop Node — ${summary}${paused ? ' (paused)' : ''}`);
		tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: `Status: ${summary}`, enabled: false },
				{ label: workLine, enabled: false },
				{ type: 'separator' },
				{ label: 'Open Desktop Node', click: () => handlers.onShow() },
				{ type: 'separator' },
				{ label: 'Connect', enabled: !connected, click: () => handlers.onConnect() },
				{ label: 'Disconnect', enabled: connected, click: () => handlers.onDisconnect() },
				{ type: 'separator' },
				{ label: 'Pause work', enabled: !paused, click: () => handlers.onPause() },
				{ label: 'Resume work', enabled: paused, click: () => handlers.onResume() },
				{ type: 'separator' },
				{ label: 'Quit', click: () => handlers.onQuit() }
			])
		);
	};

	render();
	tray.on('click', () => handlers.onShow());

	return { tray, update: render };
}
