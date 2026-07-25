import { contextBridge, ipcRenderer } from 'electron';
import type { ConnectionStatusView, DesktopNodeBridge, EnrollRequest, LogEntry } from '../shared/ipc-contract';

// IMPORTANT: this preload runs sandboxed — it cannot require local modules,
// so channel names are inlined as string literals. Keep them in sync with
// `IpcChannels` in src/shared/ipc-contract.ts (types are erased at compile
// time, so the type-only import above is sandbox-safe).
//
// The bridge is deliberately narrow: the renderer can ASK to enroll (sending a
// token in) but can never read a credential back out.

const bridge: DesktopNodeBridge = {
	listApiHosts: () => ipcRenderer.invoke('wizard:list-api-hosts'),
	detectCapabilities: () => ipcRenderer.invoke('wizard:detect-capabilities'),
	enroll: (request: EnrollRequest) => ipcRenderer.invoke('wizard:enroll', request),
	getConfig: () => ipcRenderer.invoke('config:get'),
	connect: () => ipcRenderer.invoke('node:connect'),
	disconnect: () => ipcRenderer.invoke('node:disconnect'),
	getStatus: () => ipcRenderer.invoke('node:status'),
	getLogs: () => ipcRenderer.invoke('node:logs'),
	unenroll: () => ipcRenderer.invoke('node:unenroll'),
	onStatus: (listener: (status: ConnectionStatusView) => void) => {
		const handler = (_event: unknown, status: ConnectionStatusView) => listener(status);
		ipcRenderer.on('node:status-event', handler);
		return () => ipcRenderer.removeListener('node:status-event', handler);
	},
	onLog: (listener: (entry: LogEntry) => void) => {
		const handler = (_event: unknown, entry: LogEntry) => listener(entry);
		ipcRenderer.on('node:log-event', handler);
		return () => ipcRenderer.removeListener('node:log-event', handler);
	}
};

contextBridge.exposeInMainWorld('everworksNode', bridge);
