export interface LocalAuthStatus {
	installed: boolean;
	connected: boolean;
	pending: boolean;
	authPath: string;
	verificationUri?: string;
	userCode?: string;
	message: string;
}

export interface ILocalAuthProvider {
	getLocalAuthStatus(userId: string): Promise<LocalAuthStatus>;
	startLocalAuth(userId: string): Promise<LocalAuthStatus>;
}

export function isLocalAuthProvider(value: unknown): value is ILocalAuthProvider {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return typeof candidate.getLocalAuthStatus === 'function' && typeof candidate.startLocalAuth === 'function';
}
