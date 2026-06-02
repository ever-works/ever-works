// Field names matched against the response body by exact-string equality
// (case-sensitive, no regex / prefix matching). Both camelCase and snake_case
// variants are listed for fields that travel through both REST DTOs (camel)
// and OAuth-style responses (snake). Add either spelling when introducing a
// new sensitive field — there is no automatic case-normalisation.
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
	'token',
	// Security: additional unambiguous credential/secret field names that can
	// leak through serialiser misconfigurations on auth/user/plugin responses.
	// Only exact, non-ambiguous names are added here — a bare `hash` is left
	// out on purpose because in this repo it commonly denotes a git commit /
	// content hash (a legitimate, non-sensitive value).
	'passwordHash',
	'password_hash',
	'hashedPassword',
	'hashed_password',
	'salt',
	'authToken',
	'auth_token',
	'apiToken',
	'api_token',
	'bearerToken',
	'bearer_token',
	'oauthToken',
	'oauth_token',
	'sessionToken',
	'session_token',
	'verificationToken',
	'verification_token',
	'jwt',
	'jwtToken',
	'idToken',
	'id_token',
	'twoFactorSecret',
	'two_factor_secret',
	'totpSecret',
	'totp_secret',
	'twoFactorBackupCodes',
	'backupCodes',
	'backup_codes',
	'encryptedKey',
	'encrypted_key',
	'encryptedSecret',
	'encrypted_secret',
	'otp'
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

/**
 * Strip sensitive fields from a response payload before it leaves the MCP
 * boundary, so credentials in upstream API responses never reach an LLM
 * tool result.
 *
 * Behaviour worth knowing:
 * - Fields are **dropped, not redacted** — the sanitised payload simply
 *   does not contain the key. Use this rather than a `'[REDACTED]'`
 *   sentinel because tool results are surfaced verbatim to the model,
 *   and a sentinel could mislead the model into thinking the data
 *   exists in some retrievable form.
 * - Match is **case-sensitive exact-string** against the `SENSITIVE_FIELDS`
 *   set; `Token` would not match `token`. Add casing variants explicitly.
 * - Recurses into objects and arrays; leaves primitives, `null`, and
 *   `undefined` untouched. Cycles are not handled — pass DAG-shaped
 *   data only.
 * - The return type is the input type `T`, but at runtime the shape can
 *   be narrower (missing keys). Consumers should treat it as `Partial<T>`
 *   when reading fields by name.
 *
 * @param data - Response payload from an upstream HTTP call.
 * @returns The payload with every sensitive field recursively removed.
 */
export function sanitizeResponse<T>(data: T): T {
	return sanitizeValue(data) as T;
}
