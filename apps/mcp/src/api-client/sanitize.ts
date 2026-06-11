// Field names matched against the response body. Matching is
// case-insensitive: every entry below is stored lowercase and lookups
// lowercase the candidate key first, so `PASSWORD`, `AccessToken`, and
// `apiKey` all match regardless of casing. Matching is still exact-string
// (no regex / prefix matching). Both camelCase and snake_case variants are
// listed for fields that travel through both REST DTOs (camel) and
// OAuth-style responses (snake), because lowercasing alone does not bridge
// the `_` separator (e.g. `apikey` vs `api_key`). Add new sensitive fields
// in lowercase; casing of the incoming key no longer matters.
const SENSITIVE_FIELDS = new Set([
	'password',
	'passwordresettoken',
	'passwordresetexpires',
	'emailverificationtoken',
	'emailverificationexpires',
	'lastloginip',
	'apikey',
	'api_key',
	'secret',
	'clientsecret',
	'client_secret',
	'accesstoken',
	'access_token',
	'refreshtoken',
	'refresh_token',
	'privatekey',
	'private_key',
	'token',
	// Security: additional unambiguous credential/secret field names that can
	// leak through serialiser misconfigurations on auth/user/plugin responses.
	// Only exact, non-ambiguous names are added here — a bare `hash` is left
	// out on purpose because in this repo it commonly denotes a git commit /
	// content hash (a legitimate, non-sensitive value).
	'passwordhash',
	'password_hash',
	'hashedpassword',
	'hashed_password',
	'salt',
	'authtoken',
	'auth_token',
	'apitoken',
	'api_token',
	'bearertoken',
	'bearer_token',
	'oauthtoken',
	'oauth_token',
	'sessiontoken',
	'session_token',
	'verificationtoken',
	'verification_token',
	'jwt',
	'jwttoken',
	'idtoken',
	'id_token',
	'twofactorsecret',
	'two_factor_secret',
	'totpsecret',
	'totp_secret',
	'twofactorbackupcodes',
	'backupcodes',
	'backup_codes',
	'encryptedkey',
	'encrypted_key',
	'encryptedsecret',
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
		if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
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
 * - Match is **case-insensitive exact-string** against the `SENSITIVE_FIELDS`
 *   set; the candidate key is lowercased before lookup, so `Token`,
 *   `TOKEN`, and `token` all match. Matching is still whole-key exact
 *   (no prefix / regex), so add snake_case spellings explicitly.
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
