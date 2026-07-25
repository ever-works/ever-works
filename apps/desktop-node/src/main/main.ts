import { BrowserWindow, app, ipcMain, shell } from 'electron';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
	NODE_APP_VERSION,
	createBufferedLogger,
	createCommandRunner,
	createConfigFileSystem,
	createNodeRuntime,
	currentEnvironment,
	describeSelf,
	enrollNode,
	loadConfig,
	saveConfig,
	systemFetch,
	type LogEntry,
	type NodeConfig,
	type NodeIo,
	type NodeRuntime
} from 'ever-works-node';
import type { ConnectionStatusView, EnrollRequest, EnrollOutcome, NodeIdentityView } from '../shared/ipc-contract';
import { API_HOST_OPTIONS, IpcChannels } from '../shared/ipc-contract';
import { IDLE_STATUS, enrollRequestValid, resolveEnrollApiUrl, toIdentityView, toStatusView } from './identity';
import { createTray } from './tray';

/**
 * Ever Works Desktop Node — Electron main process.
 *
 * A thin shell around `ever-works-node`'s core: the wizard collects an API
 * host and a one-time token, the core does the enrolling and heartbeating, and
 * this process owns the credential. Main-process patterns (single-instance
 * lock, sandboxed preload, navigation allow-list, tray) mirror `apps/desktop`.
 */

let mainWindow: BrowserWindow | undefined;
let quitting = false;

// ---------------------------------------------------------------------------
// Single instance lock — two nodes heartbeating with one credential would
// fight over the same config file.
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) {
				mainWindow.restore();
			}
			mainWindow.show();
			mainWindow.focus();
		}
	});

	void app.whenReady().then(() => bootstrap());
}

function bootstrap(): void {
	const userData = app.getPath('userData');
	const configPath = path.join(userData, 'node-config.json');

	// Buffered so the status window's log pane can back-fill on open; every
	// entry is redacted by the core logger before it reaches any sink.
	const logger = createBufferedLogger(500, {
		sink: (entry: LogEntry) => {
			mainWindow?.webContents.send(IpcChannels.logEvent, entry);
			process.stdout.write(`[${entry.level}] ${entry.message}\n`);
		}
	});

	const io: NodeIo = {
		fetchFn: systemFetch,
		runner: createCommandRunner(),
		environment: currentEnvironment(),
		logger,
		version: NODE_APP_VERSION,
		userAgent: `ever-works-desktop-node/${NODE_APP_VERSION}`
	};

	const fs = createConfigFileSystem();
	let config: NodeConfig | null = null;
	let runtime: NodeRuntime | null = null;
	let status: ConnectionStatusView = { ...IDLE_STATUS };

	const publishStatus = (next: ConnectionStatusView): void => {
		status = next;
		mainWindow?.webContents.send(IpcChannels.statusEvent, next);
		tray?.update(next);
	};

	const connect = (): void => {
		if (!config || runtime) {
			return;
		}
		const created = createNodeRuntime(config, io);
		created.loop.onChange((state) => publishStatus(toStatusView(state)));
		runtime = created;
		void created.loop.start();
	};

	const disconnect = async (): Promise<void> => {
		if (!runtime) {
			return;
		}
		const current = runtime;
		runtime = null;
		current.loop.stop();
		await current.loop.settled();
		publishStatus({ ...IDLE_STATUS, state: 'stopped' });
	};

	const enroll = async (request: EnrollRequest): Promise<EnrollOutcome> => {
		// The renderer is not a trust boundary: re-validate here.
		if (!enrollRequestValid(request)) {
			return { ok: false, error: 'Choose an API host and paste a complete enrollment token.' };
		}
		const apiUrl = resolveEnrollApiUrl(request);
		if (!apiUrl) {
			return { ok: false, error: 'That API URL is not usable.' };
		}

		try {
			await disconnect();
			const enrolled = await enrollNode({
				...io,
				apiUrl,
				token: request.token.trim(),
				kind: 'desktop-node',
				...(request.name ? { name: request.name } : {})
			});
			await saveConfig(fs, configPath, enrolled, { platform: process.platform });
			config = enrolled;
			connect();
			return { ok: true, identity: toIdentityView(config) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Redact defensively — this string is rendered in the wizard.
			const safe = logger.redact(message);
			logger.error(`Enrollment failed: ${safe}`);
			return { ok: false, error: safe };
		}
	};

	/**
	 * Forget this machine's local credential. NOTE: this is a LOCAL action —
	 * the node row remains in the platform's Fleet page until an admin revokes
	 * or deletes it there.
	 */
	const unenroll = async (): Promise<void> => {
		await disconnect();
		config = null;
		try {
			await fsp.rm(configPath, { force: true });
		} catch (error) {
			logger.warn(`Could not remove the local config: ${(error as Error).message}`);
		}
		publishStatus({ ...IDLE_STATUS });
		logger.info('Local enrollment removed. The node still exists in Fleet until it is revoked there.');
	};

	// -----------------------------------------------------------------------
	// IPC surface (the wizard/status renderer talks to this via the preload)
	// -----------------------------------------------------------------------

	ipcMain.handle(IpcChannels.listApiHosts, () => API_HOST_OPTIONS);
	ipcMain.handle(IpcChannels.detectCapabilities, async () => {
		const description = await describeSelf(io.runner, io.environment, io.version);
		return description.capabilities;
	});
	ipcMain.handle(IpcChannels.enroll, (_event, request: EnrollRequest) => enroll(request));
	ipcMain.handle(IpcChannels.getConfig, (): NodeIdentityView => toIdentityView(config));
	ipcMain.handle(IpcChannels.connect, () => connect());
	ipcMain.handle(IpcChannels.disconnect, () => disconnect());
	ipcMain.handle(IpcChannels.getStatus, () => status);
	ipcMain.handle(IpcChannels.getLogs, () => logger.entries());
	ipcMain.handle(IpcChannels.unenroll, () => unenroll());

	// -----------------------------------------------------------------------
	// Window & tray
	// -----------------------------------------------------------------------

	const window = new BrowserWindow({
		width: 960,
		height: 720,
		show: false,
		autoHideMenuBar: true,
		webPreferences: {
			// Secure defaults: isolated world, no Node in the renderer,
			// sandboxed preload exposing only the minimal typed bridge.
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			preload: path.join(__dirname, 'preload.js')
		}
	});
	mainWindow = window;

	// This shell renders only its own local bundle — unlike the all-in-one
	// desktop app it never embeds the platform web UI, so every external URL
	// goes to the OS browser.
	window.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: 'deny' };
	});
	window.webContents.on('will-navigate', (event, url) => {
		if (url.startsWith('file:')) {
			return;
		}
		event.preventDefault();
		void shell.openExternal(url);
	});

	const devServerUrl = process.env.VITE_DEV_SERVER_URL;
	if (devServerUrl) {
		void window.loadURL(devServerUrl);
	} else {
		void window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
	}
	window.once('ready-to-show', () => window.show());
	window.on('close', (event) => {
		// Minimize-to-tray: closing the window keeps the node heartbeating.
		if (!quitting) {
			event.preventDefault();
			window.hide();
		}
	});

	const tray = createTray({
		onShow: () => {
			window.show();
			window.focus();
		},
		onConnect: () => connect(),
		onDisconnect: () => void disconnect(),
		onQuit: () => {
			quitting = true;
			app.quit();
		}
	});

	app.on('before-quit', (event) => {
		quitting = true;
		if (runtime) {
			event.preventDefault();
			void disconnect().then(() => app.quit());
		}
	});

	// -----------------------------------------------------------------------
	// Auto-start: an already-enrolled machine starts heartbeating on launch,
	// without waiting for the window to be opened.
	// -----------------------------------------------------------------------

	void loadConfig(fs, configPath)
		.then((stored) => {
			config = stored;
			if (stored) {
				logger.info(`Resuming node ${stored.nodeId} → ${stored.apiUrl}`);
				connect();
			} else {
				logger.info('Not enrolled yet — the setup wizard will guide enrollment.');
			}
		})
		.catch((error: unknown) => {
			logger.error(`Could not read the stored config: ${(error as Error).message}`);
		});
}
