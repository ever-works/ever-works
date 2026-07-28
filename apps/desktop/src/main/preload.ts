import { contextBridge, ipcRenderer } from 'electron';
import type {
	DesktopBridge,
	DesktopMode,
	LogEntry,
	RemoteConnectionInput,
	RuntimeSelection,
	ServiceId,
	ServiceStatus
} from '../shared/ipc-contract';

// IMPORTANT: this preload runs sandboxed — it cannot require local modules,
// so channel names are inlined as string literals. Keep them in sync with
// `IpcChannels` in src/shared/ipc-contract.ts (types are erased at compile
// time, so the type-only import above is sandbox-safe).

const bridge: DesktopBridge = {
	checkPrereqs: () => ipcRenderer.invoke('wizard:check-prereqs'),
	listRuntimes: () => ipcRenderer.invoke('wizard:list-runtimes'),
	detectDocker: () => ipcRenderer.invoke('wizard:detect-docker'),
	applyRuntime: (selection: RuntimeSelection) => ipcRenderer.invoke('wizard:apply-runtime', selection),
	setMode: (mode: DesktopMode) => ipcRenderer.invoke('wizard:set-mode', mode),
	testRemote: (input: RemoteConnectionInput) => ipcRenderer.invoke('wizard:test-remote', input),
	saveRemote: (input: RemoteConnectionInput) => ipcRenderer.invoke('wizard:save-remote', input),
	completeWizard: () => ipcRenderer.invoke('wizard:complete'),
	getConfig: () => ipcRenderer.invoke('config:get'),
	getRuntimeLayout: () => ipcRenderer.invoke('app:runtime-layout'),
	startServices: () => ipcRenderer.invoke('services:start'),
	stopServices: () => ipcRenderer.invoke('services:stop'),
	restartService: (id: ServiceId) => ipcRenderer.invoke('services:restart', id),
	getStatus: () => ipcRenderer.invoke('services:status'),
	getLogs: (id: ServiceId) => ipcRenderer.invoke('services:logs', id),
	openWebApp: () => ipcRenderer.invoke('app:open-web'),
	onStatus: (listener: (statuses: ServiceStatus[]) => void) => {
		const handler = (_event: unknown, statuses: ServiceStatus[]) => listener(statuses);
		ipcRenderer.on('services:status-event', handler);
		return () => ipcRenderer.removeListener('services:status-event', handler);
	},
	onLog: (listener: (entry: LogEntry) => void) => {
		const handler = (_event: unknown, entry: LogEntry) => listener(entry);
		ipcRenderer.on('services:log-event', handler);
		return () => ipcRenderer.removeListener('services:log-event', handler);
	}
};

contextBridge.exposeInMainWorld('everworks', bridge);
