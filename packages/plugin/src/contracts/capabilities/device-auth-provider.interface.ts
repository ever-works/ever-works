export interface DeviceAuthPrompt {
	verificationUri: string;
	userCode: string;
}

export interface DeviceAuthStatus {
	installed: boolean;
	connected: boolean;
	pending: boolean;
	scope: 'user';
	flowType: 'device-code';
	prompt?: DeviceAuthPrompt;
	message: string;
}

export interface IDeviceAuthProvider {
	getDeviceAuthStatus(userId: string): Promise<DeviceAuthStatus>;
	startDeviceAuth(userId: string): Promise<DeviceAuthStatus>;
	cancelDeviceAuth?(userId: string): Promise<DeviceAuthStatus>;
}

export function isDeviceAuthProvider(value: unknown): value is IDeviceAuthProvider {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return typeof candidate.getDeviceAuthStatus === 'function' && typeof candidate.startDeviceAuth === 'function';
}
