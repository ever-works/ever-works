import type { FacadeOptions } from './facade-options.interface.js';

export interface IBaseFacade {
	isConfigured(): boolean;
	getActiveProviderName?(facadeOptions: FacadeOptions): Promise<string | null>;
}
