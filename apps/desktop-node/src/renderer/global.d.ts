import type { DesktopNodeBridge } from '../shared/ipc-contract';

declare global {
	interface Window {
		/** Exposed by the preload bridge; absent when the renderer runs in a plain browser (vite dev). */
		everworksNode?: DesktopNodeBridge;
	}
}

export {};
