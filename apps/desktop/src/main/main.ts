import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
	DesktopConfig,
	DesktopMode,
	RemoteConnectionInput,
	RuntimeSelection,
	ServiceId
} from '../shared/ipc-contract';
import { IpcChannels } from '../shared/ipc-contract';
import { JOB_RUNTIMES } from '../shared/runtimes';
import { API_HEALTH_URL, WEB_APP_URL, waitForHealthy } from '../services/health';
import { ProcessManager } from '../services/process-manager';
import type { CommandRunner } from '../services/prereq-check';
import { checkPrerequisites } from '../services/prereq-check';
import { allowedOriginsFor, probeRemote, resolveRemoteConnection } from '../services/remote-connection';
import type { LayoutIo, LayoutProbeInput, RuntimeLayout } from '../services/runtime-layout';
import { resolveRuntimeLayout, resolveServiceLaunch, toLayoutSummary } from '../services/runtime-layout';
import type { RuntimeSetupIo } from '../services/runtime-setup';
import { applyRuntimeSelection, detectDocker } from '../services/runtime-setup';
import { loadConfig, saveConfig } from './config-store';
import { createTray } from './tray';

// ---------------------------------------------------------------------------
// Paths & state
// ---------------------------------------------------------------------------

const layoutIo: LayoutIo = {
	exists: (candidate) => fs.existsSync(candidate),
	readFile: (candidate) => {
		try {
			return fs.readFileSync(candidate, 'utf8');
		} catch {
			return undefined;
		}
	},
	join: (...segments) => path.resolve(path.join(...segments))
};

/**
 * Where the supervised services come from for THIS install.
 *
 * Packaged installers ship a self-contained runtime payload under
 * `resources/app-bundle`, so an installed app needs neither a monorepo
 * checkout nor Node.js/pnpm on the host. Developer runs and installs that
 * explicitly point `EVER_WORKS_REPO_ROOT` at a checkout keep the old
 * run-from-source behavior.
 */
function resolveLayout(): RuntimeLayout {
	const input: LayoutProbeInput = { appPath: app.getAppPath() };
	if (app.isPackaged && process.resourcesPath) {
		input.resourcesPath = process.resourcesPath;
	}
	if (process.env.EVER_WORKS_REPO_ROOT) {
		input.envRepoRoot = path.resolve(process.env.EVER_WORKS_REPO_ROOT);
	}
	return resolveRuntimeLayout(layoutIo, input);
}

const runCommand: CommandRunner['run'] = (command, args) =>
	new Promise((resolve) => {
		execFile(command, args, { shell: process.platform === 'win32', windowsHide: true }, (error, stdout, stderr) => {
			const code = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code ?? 1) : 0;
			resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) });
		});
	});

const commandRunner: CommandRunner = { run: runCommand };

const runtimeSetupIo: RuntimeSetupIo = {
	run: (command, args, options) =>
		new Promise((resolve) => {
			execFile(
				command,
				args,
				{ cwd: options?.cwd, shell: process.platform === 'win32', windowsHide: true },
				(error, stdout, stderr) => {
					const code = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code ?? 1) : 0;
					resolve({
						code: typeof code === 'number' ? code : 1,
						stdout: String(stdout),
						stderr: String(stderr)
					});
				}
			);
		}),
	readFile: async (filePath) => {
		try {
			return fs.readFileSync(filePath, 'utf8');
		} catch {
			return undefined;
		}
	},
	writeFile: async (filePath, content) => {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, content, 'utf8');
	}
};

let mainWindow: BrowserWindow | undefined;
let quitting = false;

// ---------------------------------------------------------------------------
// Single instance lock
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

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function bootstrap(): void {
	const layout = resolveLayout();
	const userData = app.getPath('userData');
	const configPath = path.join(userData, 'desktop-config.json');
	const envFilePath = path.join(userData, 'ever-works-desktop.env');
	const sqliteDbPath = path.join(userData, 'ever-works.db');

	let config: DesktopConfig = loadConfig(configPath);

	if (layout.kind === 'unavailable') {
		// Loud, actionable degradation: local-stack mode cannot start anything.
		// Client mode still works, which is exactly what the wizard offers next.
		console.error(
			`[ever-works-desktop] No platform runtime available (${layout.reason ?? 'unknown reason'}). ` +
				'Local-stack mode is disabled for this install — either reinstall a build that bundles the runtime, ' +
				'set EVER_WORKS_REPO_ROOT to a monorepo checkout, or use client mode to connect to a remote instance.'
		);
	}

	const manager = new ProcessManager({
		spawnFn: (command, args, options) =>
			spawn(command, args, {
				cwd: options.cwd,
				env: options.env as NodeJS.ProcessEnv | undefined,
				shell: options.shell,
				windowsHide: true
			}),
		scheduler: {
			setTimeout: (callback, ms) => setTimeout(callback, ms),
			clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
		}
	});

	const envEntries = (): Record<string, string> => {
		const content = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf8') : '';
		const entries: Record<string, string> = {};
		for (const line of content.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed === '' || trimmed.startsWith('#')) {
				continue;
			}
			const eq = trimmed.indexOf('=');
			if (eq > 0) {
				let value = trimmed.slice(eq + 1).trim();
				if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
					value = value.slice(1, -1);
				}
				entries[trimmed.slice(0, eq).trim()] = value;
			}
		}
		return entries;
	};

	const ensureServices = (): boolean => {
		if (manager.all().length > 0) {
			return true;
		}
		const env = envEntries();
		const api = resolveServiceLaunch('api', layout, layoutIo, { nodeExecPath: process.execPath });
		const web = resolveServiceLaunch('web', layout, layoutIo, { nodeExecPath: process.execPath });
		if (!api || !web) {
			console.error(
				'[ever-works-desktop] Cannot start the local stack: no runtime payload and no monorepo checkout.'
			);
			return false;
		}
		manager.create({
			id: 'api',
			command: api.command,
			args: api.args,
			cwd: api.cwd,
			env: { ...env, ...api.env },
			readyPattern: /Nest application successfully started|listening/i
		});
		manager.create({
			id: 'web',
			command: web.command,
			args: web.args,
			cwd: web.cwd,
			env: { ...env, ...web.env },
			readyPattern: /ready|started server|compiled/i
		});
		for (const service of manager.all()) {
			service.onStatusChange(() => {
				mainWindow?.webContents.send(IpcChannels.statusEvent, manager.statuses());
			});
			service.onLog((entry) => {
				mainWindow?.webContents.send(IpcChannels.logEvent, entry);
			});
		}
		return true;
	};

	const startServices = (): void => {
		if (config.mode === 'remote-client') {
			// Client mode supervises nothing — the platform runs elsewhere.
			return;
		}
		if (!ensureServices()) {
			return;
		}
		manager.startAll();
		// Flip per-service health flags as the local endpoints come up.
		void waitForHealthy(API_HEALTH_URL, { fetchFn: (url) => fetch(url) }).then((healthy) => {
			manager.get('api')?.setHealthy(healthy);
		});
		void waitForHealthy(WEB_APP_URL, { fetchFn: (url) => fetch(url) }).then((healthy) => {
			manager.get('web')?.setHealthy(healthy);
		});
	};

	const stopServices = async (): Promise<void> => {
		await manager.stopAll();
	};

	/** The URL the main window shows once setup is done. */
	const appUrl = (): string =>
		config.mode === 'remote-client' && config.remote ? config.remote.webUrl : WEB_APP_URL;

	// Keep navigation inside the app: the local wizard bundle plus whichever
	// instance this install targets — the two local service origins in
	// local-stack mode, or the remote instance's origins in client mode.
	// Everything else opens in the OS browser.
	let allowedOrigins = new Set<string>();

	const refreshAllowedOrigins = (): void => {
		allowedOrigins = new Set(
			allowedOriginsFor(config.mode === 'remote-client' ? config.remote : undefined, [
				WEB_APP_URL,
				'http://localhost:3100'
			])
		);
	};

	refreshAllowedOrigins();

	// -----------------------------------------------------------------------
	// IPC surface (the wizard/status renderer talks to this via the preload)
	// -----------------------------------------------------------------------

	ipcMain.handle(IpcChannels.checkPrereqs, () =>
		checkPrerequisites(commandRunner, { requireHostToolchain: layout.requiresHostToolchain })
	);
	ipcMain.handle(IpcChannels.listRuntimes, () => JOB_RUNTIMES);
	ipcMain.handle(IpcChannels.detectDocker, () => detectDocker(runtimeSetupIo));
	ipcMain.handle(IpcChannels.getRuntimeLayout, () => toLayoutSummary(layout));
	ipcMain.handle(IpcChannels.applyRuntime, async (_event, selection: RuntimeSelection) => {
		const result = await applyRuntimeSelection(runtimeSetupIo, {
			selection,
			envFilePath,
			// Only used as the cwd for `docker compose -f docker-compose.infra.yml`,
			// which is a repo-checkout affordance; bundled installs default to the
			// embedded SQLite database and never take that path.
			repoRoot: layout.repoRoot ?? layout.bundleRoot ?? app.getAppPath(),
			sqliteDbPath
		});
		config = { ...config, selection, envFilePath };
		saveConfig(configPath, config);
		return { envFilePath: result.envFilePath, keys: Object.keys(result.entries) };
	});
	ipcMain.handle(IpcChannels.setMode, (_event, mode: DesktopMode) => {
		config = { ...config, mode };
		saveConfig(configPath, config);
		refreshAllowedOrigins();
		return config;
	});
	ipcMain.handle(IpcChannels.testRemote, async (_event, input: RemoteConnectionInput) => {
		const resolution = resolveRemoteConnection(input);
		if (!resolution.ok) {
			return { ok: false, message: resolution.errors.join(' ') };
		}
		return probeRemote(resolution.connection, (url) => fetch(url));
	});
	ipcMain.handle(IpcChannels.saveRemote, (_event, input: RemoteConnectionInput) => {
		const resolution = resolveRemoteConnection(input);
		if (!resolution.ok) {
			throw new Error(resolution.errors.join(' '));
		}
		config = { ...config, mode: 'remote-client', remote: resolution.connection };
		saveConfig(configPath, config);
		refreshAllowedOrigins();
		return resolution.connection;
	});
	ipcMain.handle(IpcChannels.completeWizard, () => {
		config = { ...config, wizardCompleted: true };
		saveConfig(configPath, config);
	});
	ipcMain.handle(IpcChannels.getConfig, () => config);
	ipcMain.handle(IpcChannels.startServices, () => startServices());
	ipcMain.handle(IpcChannels.stopServices, () => stopServices());
	ipcMain.handle(IpcChannels.restartService, (_event, id: ServiceId) => manager.get(id)?.restart());
	ipcMain.handle(IpcChannels.getStatus, () => manager.statuses());
	ipcMain.handle(IpcChannels.getLogs, (_event, id: ServiceId) => manager.get(id)?.logs.toArray() ?? []);
	ipcMain.handle(IpcChannels.openWebApp, () => {
		void mainWindow?.loadURL(appUrl());
	});

	// -----------------------------------------------------------------------
	// Window & tray
	// -----------------------------------------------------------------------

	const window = new BrowserWindow({
		width: 1280,
		height: 840,
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

	window.webContents.setWindowOpenHandler(({ url }) => {
		void shell.openExternal(url);
		return { action: 'deny' };
	});
	window.webContents.on('will-navigate', (event, url) => {
		if (url.startsWith('file:')) {
			return;
		}
		try {
			if (!allowedOrigins.has(new URL(url).origin)) {
				event.preventDefault();
				void shell.openExternal(url);
			}
		} catch {
			event.preventDefault();
		}
	});

	const devServerUrl = process.env.VITE_DEV_SERVER_URL;
	if (devServerUrl) {
		void window.loadURL(devServerUrl);
	} else {
		void window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
	}
	window.once('ready-to-show', () => window.show());
	window.on('close', (event) => {
		// Minimize-to-tray behavior: closing the window keeps services alive.
		if (!quitting) {
			event.preventDefault();
			window.hide();
		}
	});

	createTray({
		onShow: () => {
			window.show();
			window.focus();
		},
		onStartServices: () => startServices(),
		onStopServices: () => void stopServices(),
		onQuit: () => {
			quitting = true;
			app.quit();
		}
	});

	app.on('before-quit', (event) => {
		quitting = true;
		if (manager.statuses().some((status) => status.state !== 'stopped' && status.state !== 'failed')) {
			event.preventDefault();
			void stopServices().then(() => app.quit());
		}
	});
}
