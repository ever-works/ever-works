import { BrowserWindow, app, ipcMain, shell } from 'electron';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
	NODE_APP_VERSION,
	PlatformAuthClient,
	clampResourceLimits,
	createBufferedLogger,
	createCommandRunner,
	createDiskProbe,
	createConfigFileSystem,
	createNodeRuntime,
	createResourceProbe,
	currentEnvironment,
	describeSelf,
	enrollNode,
	enrollNodeWithCredentials,
	loadConfig,
	saveConfig,
	systemFetch,
	type LogEntry,
	type NodeConfig,
	type NodeIo,
	type NodeRuntime
} from 'ever-works-node';
import type {
	AuthenticateOutcome,
	AuthenticateRequest,
	ConnectionStatusView,
	EnrollRequest,
	EnrollOutcome,
	NodeIdentityView,
	WorkerStatusView
} from '../shared/ipc-contract';
import { API_HOST_OPTIONS, IDLE_WORKER_STATUS, IpcChannels } from '../shared/ipc-contract';
import {
	IDLE_STATUS,
	authenticateRequestValid,
	enrollRequestValid,
	requestedEnrollMode,
	resolveEnrollApiUrl,
	resolveNodeName,
	toIdentityView,
	toStatusView,
	toWorkerStatusView
} from './identity';
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
		userAgent: `ever-works-desktop-node/${NODE_APP_VERSION}`,
		// Backs the free-disk figure in the Fleet runner indicator.
		// Optional by contract — an unreadable volume reports nothing
		// rather than failing the heartbeat that carries everything else.
		diskProbe: createDiskProbe()
	};

	const fs = createConfigFileSystem();
	const resourceProbe = createResourceProbe();
	let config: NodeConfig | null = null;
	let runtime: NodeRuntime | null = null;
	let status: ConnectionStatusView = { ...IDLE_STATUS };
	let workerStatus: WorkerStatusView = { ...IDLE_WORKER_STATUS };
	// Survives disconnect/reconnect: an operator who paused the node expects it
	// to still be paused after a reconnect, not quietly back at work.
	let pausedByOperator = false;

	const publishStatus = (next: ConnectionStatusView): void => {
		status = next;
		mainWindow?.webContents.send(IpcChannels.statusEvent, next);
		tray?.update(next);
	};

	/** Re-emit the current status with a refreshed worker projection. */
	const republish = (): void => publishStatus({ ...status, worker: workerStatus });

	const connect = (): void => {
		if (!config || runtime) {
			return;
		}
		const created = createNodeRuntime(config, io, {
			// A desktop node exists to DO work; the ceilings the operator set
			// in the wizard are what makes that safe to enable by default.
			workerEnabled: true,
			limits: clampResourceLimits(config.limits),
			resourceProbe,
			startPaused: pausedByOperator
		});
		created.loop.onChange((state) => publishStatus(toStatusView(state, workerStatus)));
		created.worker?.onChange((state) => {
			workerStatus = toWorkerStatusView(state);
			pausedByOperator = state.paused;
			republish();
		});
		workerStatus = toWorkerStatusView(created.worker?.getState());
		runtime = created;
		void created.loop.start();
		void created.worker?.start();
	};

	const disconnect = async (): Promise<void> => {
		if (!runtime) {
			return;
		}
		const current = runtime;
		runtime = null;
		current.loop.stop();
		// Drains: in-flight jobs report their verdicts instead of being
		// abandoned to a lease expiry.
		await Promise.all([current.loop.settled(), current.worker?.stop() ?? Promise.resolve()]);
		workerStatus = { ...IDLE_WORKER_STATUS, paused: pausedByOperator };
		publishStatus({ ...IDLE_STATUS, state: 'stopped', worker: workerStatus });
	};

	/**
	 * A18 — pause/resume, wired to the worker loop's real state rather than a
	 * UI-only flag. Pausing stops LEASING; the heartbeat keeps running so the
	 * node stays visible in Fleet, and jobs already executing still finish and
	 * report.
	 */
	const pause = (): void => {
		pausedByOperator = true;
		if (runtime?.worker) {
			runtime.worker.pause();
			return;
		}
		// Not connected yet: remember the intent so `connect()` starts paused.
		workerStatus = { ...workerStatus, paused: true };
		republish();
	};

	const resume = (): void => {
		pausedByOperator = false;
		if (runtime?.worker) {
			runtime.worker.resume();
			return;
		}
		workerStatus = { ...workerStatus, paused: false };
		republish();
	};

	/**
	 * A14 — verify platform credentials without enrolling. Lets the wizard
	 * fail fast on a typo instead of surfacing it several steps later.
	 */
	const authenticate = async (request: AuthenticateRequest): Promise<AuthenticateOutcome> => {
		if (!authenticateRequestValid(request)) {
			return { ok: false, error: 'Choose an API host and enter your email and password.' };
		}
		const apiUrl = resolveEnrollApiUrl(request);
		if (!apiUrl) {
			return { ok: false, error: 'That API URL is not usable.' };
		}
		try {
			const auth = new PlatformAuthClient({
				apiUrl,
				fetchFn: io.fetchFn,
				logger,
				userAgent: io.userAgent
			});
			const session = await auth.signIn(request.email, request.password);
			logger.info(`Signed in to ${apiUrl}`);
			return { ok: true, ...(session.email ? { email: session.email } : {}) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const safe = logger.redact(message);
			logger.warn(`Sign-in failed: ${safe}`);
			return { ok: false, error: safe };
		}
	};

	const enroll = async (request: EnrollRequest): Promise<EnrollOutcome> => {
		// The renderer is not a trust boundary: re-validate here.
		if (!enrollRequestValid(request)) {
			return {
				ok: false,
				error:
					requestedEnrollMode(request) === 'sign-in'
						? 'Choose an API host and enter your email and password.'
						: 'Choose an API host and paste a complete enrollment token.'
			};
		}
		const apiUrl = resolveEnrollApiUrl(request);
		if (!apiUrl) {
			return { ok: false, error: 'That API URL is not usable.' };
		}

		try {
			await disconnect();
			// Both legs converge on the same single-use-token protocol; only
			// the way the token is OBTAINED differs (A14).
			const common = {
				...io,
				apiUrl,
				kind: 'desktop-node' as const,
				...(request.name ? { name: request.name } : {}),
				...(request.capabilities ? { capabilitySelection: request.capabilities } : {}),
				...(request.limits ? { limits: request.limits } : {})
			};
			const enrolled =
				requestedEnrollMode(request) === 'sign-in'
					? await enrollNodeWithCredentials({
							...common,
							email: (request.email ?? '').trim(),
							password: request.password ?? '',
							nodeName: resolveNodeName(request)
						})
					: await enrollNode({ ...common, token: (request.token ?? '').trim() });
			await saveConfig(fs, configPath, enrolled, { platform: process.platform });
			config = enrolled;
			pausedByOperator = false;
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
		pausedByOperator = false;
		workerStatus = { ...IDLE_WORKER_STATUS };
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
		// Unfiltered: the wizard needs the full detected set to render the
		// capability CHOICES, and the operator's opt-in is applied later.
		const description = await describeSelf(io.runner, io.environment, io.version);
		return description.capabilities;
	});
	ipcMain.handle(IpcChannels.authenticate, (_event, request: AuthenticateRequest) => authenticate(request));
	ipcMain.handle(IpcChannels.enroll, (_event, request: EnrollRequest) => enroll(request));
	ipcMain.handle(IpcChannels.getConfig, (): NodeIdentityView => toIdentityView(config));
	ipcMain.handle(IpcChannels.connect, () => connect());
	ipcMain.handle(IpcChannels.disconnect, () => disconnect());
	ipcMain.handle(IpcChannels.pause, () => pause());
	ipcMain.handle(IpcChannels.resume, () => resume());
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
		onPause: () => pause(),
		onResume: () => resume(),
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
