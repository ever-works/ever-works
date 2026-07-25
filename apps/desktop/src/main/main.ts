import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopConfig, RuntimeSelection, ServiceId } from '../shared/ipc-contract';
import { IpcChannels } from '../shared/ipc-contract';
import { JOB_RUNTIMES } from '../shared/runtimes';
import { API_HEALTH_URL, WEB_APP_URL, waitForHealthy } from '../services/health';
import { ProcessManager, resolveServiceCommand } from '../services/process-manager';
import type { CommandRunner } from '../services/prereq-check';
import { checkPrerequisites } from '../services/prereq-check';
import type { RuntimeSetupIo } from '../services/runtime-setup';
import { applyRuntimeSelection, detectDocker } from '../services/runtime-setup';
import { loadConfig, saveConfig } from './config-store';
import { createTray } from './tray';

// ---------------------------------------------------------------------------
// Paths & state
// ---------------------------------------------------------------------------

/**
 * The monorepo root the supervised services run from. In development
 * (`electron .` from apps/desktop) the app path is apps/desktop, so the root
 * is two levels up. Packaged installs must point EVER_WORKS_REPO_ROOT at a
 * platform checkout until bundled dist builds ship (PRD M6 follow-up).
 */
function resolveRepoRoot(): string {
	if (process.env.EVER_WORKS_REPO_ROOT) {
		return path.resolve(process.env.EVER_WORKS_REPO_ROOT);
	}
	return path.resolve(app.getAppPath(), '..', '..');
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
	const repoRoot = resolveRepoRoot();
	const userData = app.getPath('userData');
	const configPath = path.join(userData, 'desktop-config.json');
	const envFilePath = path.join(userData, 'ever-works-desktop.env');
	const sqliteDbPath = path.join(userData, 'ever-works.db');

	let config: DesktopConfig = loadConfig(configPath);

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

	const ensureServices = (): void => {
		if (manager.all().length > 0) {
			return;
		}
		const env = envEntries();
		const exists = (candidate: string) => fs.existsSync(candidate);
		const api = resolveServiceCommand('api', repoRoot, exists, path.join);
		const web = resolveServiceCommand('web', repoRoot, exists, path.join);
		manager.create({ id: 'api', ...api, env, readyPattern: /Nest application successfully started|listening/i });
		manager.create({ id: 'web', ...web, env, readyPattern: /ready|started server|compiled/i });
		for (const service of manager.all()) {
			service.onStatusChange(() => {
				mainWindow?.webContents.send(IpcChannels.statusEvent, manager.statuses());
			});
			service.onLog((entry) => {
				mainWindow?.webContents.send(IpcChannels.logEvent, entry);
			});
		}
	};

	const startServices = (): void => {
		ensureServices();
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

	// -----------------------------------------------------------------------
	// IPC surface (the wizard/status renderer talks to this via the preload)
	// -----------------------------------------------------------------------

	ipcMain.handle(IpcChannels.checkPrereqs, () => checkPrerequisites(commandRunner));
	ipcMain.handle(IpcChannels.listRuntimes, () => JOB_RUNTIMES);
	ipcMain.handle(IpcChannels.detectDocker, () => detectDocker(runtimeSetupIo));
	ipcMain.handle(IpcChannels.applyRuntime, async (_event, selection: RuntimeSelection) => {
		const result = await applyRuntimeSelection(runtimeSetupIo, {
			selection,
			envFilePath,
			repoRoot,
			sqliteDbPath
		});
		config = { ...config, selection, envFilePath };
		saveConfig(configPath, config);
		return { envFilePath: result.envFilePath, keys: Object.keys(result.entries) };
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
		mainWindow?.loadURL(WEB_APP_URL);
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

	// Keep navigation inside the app: local wizard bundle + the two local
	// service origins. Everything else opens in the OS browser.
	const allowedOrigins = new Set(['http://localhost:3000', 'http://localhost:3100']);
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
