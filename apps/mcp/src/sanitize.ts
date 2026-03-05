const SENSITIVE_FIELDS = new Set([
	'password',
	'passwordResetToken',
	'passwordResetExpires',
	'emailVerificationToken',
	'emailVerificationExpires',
	'lastLoginIp'
]);

export function sanitizeResponse<T>(data: T): T {
	if (data === null || data === undefined || typeof data !== 'object') {
		return data;
	}

	if (Array.isArray(data)) {
		return data.map((item) => sanitizeResponse(item)) as T;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
		if (SENSITIVE_FIELDS.has(key)) {
			continue;
		}
		result[key] = sanitizeResponse(value);
	}
	return result as T;
}
