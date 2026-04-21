const SENSITIVE_FIELDS = new Set([
	'password',
	'passwordResetToken',
	'passwordResetExpires',
	'emailVerificationToken',
	'emailVerificationExpires',
	'lastLoginIp',
	'apiKey',
	'api_key',
	'secret',
	'clientSecret',
	'client_secret',
	'accessToken',
	'access_token',
	'refreshToken',
	'refresh_token',
	'privateKey',
	'private_key',
	'token'
]);

function sanitizeValue(data: unknown): unknown {
	if (data === null || data === undefined || typeof data !== 'object') {
		return data;
	}

	if (Array.isArray(data)) {
		return data.map((item) => sanitizeValue(item));
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
		if (SENSITIVE_FIELDS.has(key)) {
			continue;
		}
		result[key] = sanitizeValue(value);
	}
	return result;
}

export function sanitizeResponse<T>(data: T): T {
	return sanitizeValue(data) as T;
}
