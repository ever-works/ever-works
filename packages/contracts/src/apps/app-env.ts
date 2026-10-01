/**
 * App env — the shared contract for APW-07's Environment table and its
 * resolver.
 *
 * Owning epic: **APW-07 (App env & dependencies)**. Implements
 * `docs/specs/features/app-works/APW-07-app-env-and-dependencies/spec.md`
 * and its `plan.md` §2.2 (resolution + the one fingerprint rule),
 * §3.1 (`work_app_env_values`), §3.3 (shared types), §4.3 (generators),
 * §4.4 (validation), §4.6.1 (the runner recipe) and §4.6.2 (build
 * resolution).
 *
 * The `AppEnvEntryView` shape is what the table renders and what APW-05
 * and APW-06 read for gating; `AppEnvRecipeEntry` is the value-free
 * recipe APW-05's runner verification materialises. Neither carries a
 * stored value: **no stored or resolved value is returned by any
 * endpoint, rendered on any screen, written to any log, placed in
 * Activity or telemetry, or included in an error message** (FR-5), with
 * the two documented exceptions — a `value` literal already public in the
 * App spec file, and a keypair public half (FR-15).
 */

/* ------------------------------------------------------------------------- *
 * Closed unions (plan §3.3:237–258)
 * ------------------------------------------------------------------------- */

/**
 * Where an entry's current value comes from (FR-2's **Generated**,
 * **Derived**, **Prompted**, **Set by you**, **Default**).
 *
 * The `work_app_env_values.origin` column stores only four of these
 * (`generated | prompted | user | derived`, plan §3.1:182): `default` is not a
 * stored origin — it describes a row that does not exist because the entry
 * follows the App spec unchanged. The union carries it so the table can render
 * the state without inventing a fifth column value.
 */
export const APP_ENV_ORIGINS = ['generated', 'derived', 'prompted', 'user', 'default'] as const;

/** An entry's origin — plan §3.3:237, spec FR-2:195–196. */
export type AppEnvOrigin = (typeof APP_ENV_ORIGINS)[number];

/** The origins a stored row may actually carry — plan §3.1:182. */
export const APP_ENV_STORED_ORIGINS = ['generated', 'prompted', 'user', 'derived'] as const;

/** A stored row's origin — plan §3.1:182. */
export type AppEnvStoredOrigin = (typeof APP_ENV_STORED_ORIGINS)[number];

/** Which resolution phases an entry takes part in (FR-2's Build / Run / both). */
export const APP_ENV_PHASES = ['build', 'runtime', 'both'] as const;

/** An entry's phase — plan §3.3:238. */
export type AppEnvPhase = (typeof APP_ENV_PHASES)[number];

/** The generator kinds (FR-10, plan §3.3:239). */
export const APP_ENV_GENERATOR_KINDS = ['base64', 'hex', 'chars', 'uuid', 'keypair'] as const;

/** A generator kind — plan §3.3:239. */
export type AppEnvGeneratorKind = (typeof APP_ENV_GENERATOR_KINDS)[number];

/**
 * The `chars` alphabets (FR-10: alnum 62 characters; alnum-symbols alnum plus
 * `!#%+,-.:=?@^_~`; hex-lower; base64url).
 */
export const APP_ENV_ALPHABETS = {
	alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
	'alnum-symbols': 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%+,-.:=?@^_~',
	'hex-lower': '0123456789abcdef',
	base64url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
} as const;

/** A `chars` alphabet name — plan §3.3:240–245. */
export type AppEnvAlphabet = keyof typeof APP_ENV_ALPHABETS;

/** The keypair types (FR-14, plan §3.3:246). */
export const APP_ENV_KEYPAIR_TYPES = ['ed25519', 'ec-p256', 'rsa-2048', 'rsa-4096'] as const;

/** A keypair type — plan §3.3:246. */
export type AppEnvKeypairType = (typeof APP_ENV_KEYPAIR_TYPES)[number];

/** The keypair formats; `pem` is the default (Resolution R-11, plan §3.3:247). */
export const APP_ENV_KEYPAIR_FORMATS = ['pem', 'base64url-raw', 'pkcs12'] as const;

/** A keypair format — Resolution R-11. */
export type AppEnvKeypairFormat = (typeof APP_ENV_KEYPAIR_FORMATS)[number];

/**
 * The keypair types `base64url-raw` supports — FR-14: "`ed25519` and `ec-p256`
 * only; an RSA type with this format is refused by the App spec".
 */
export const APP_ENV_KEYPAIR_RAW_TYPES = ['ed25519', 'ec-p256'] as const;

/** A `base64url-raw`-capable keypair type — plan §3.3:248. */
export type AppEnvKeypairRawType = (typeof APP_ENV_KEYPAIR_RAW_TYPES)[number];

/** The default keypair format — Resolution R-11 / FR-14. */
export const APP_ENV_KEYPAIR_DEFAULT_FORMAT = 'pem' as const;

/** The App spec env-name grammar (FR-18, plan §3.3:249). */
export const APP_ENV_NAME_PATTERN = '^[A-Z_][A-Z0-9_]{0,127}$' as const;

/** Prefix of the dependency password token `{{gen:DEP_<KIND>_PASSWORD}}` — plan §4.6.1:447. */
export const APP_ENV_DEP_PASSWORD_TOKEN_PREFIX = 'DEP_' as const;

/** Second half of the dependency password token — plan §4.6.1:447. */
export const APP_ENV_DEP_PASSWORD_TOKEN_SUFFIX = '_PASSWORD' as const;

/** Names with this prefix are reserved for the platform and refused (FR-18). */
export const APP_ENV_RESERVED_PREFIX = 'EVER_WORKS_' as const;

/**
 * Browser-exposed prefixes that make a warning mandatory (FR-20):
 * "Values with this prefix are sent to every visitor's browser."
 */
export const APP_ENV_PUBLIC_PREFIXES = [
	'NEXT_PUBLIC_',
	'VITE_',
	'PUBLIC_',
	'REACT_APP_',
	'NUXT_PUBLIC_',
	'EXPO_PUBLIC_'
] as const;

/** A browser-exposed env-name prefix — FR-20 / plan §3.3:251–258. */
export type AppEnvPublicPrefix = (typeof APP_ENV_PUBLIC_PREFIXES)[number];

/** The `generate.format` value a keypair public half is stored under — FR-14. */
export const APP_ENV_PUBLIC_HALF_SUFFIX = '_PUBLIC' as const;

/** The one `rotate` value App spec version 1 has (FR-13, plan §3.3:286). */
export const APP_ENV_ROTATE_MODES = ['never'] as const;

/** An entry's `rotate` mode — FR-13 / plan §3.3:286. */
export type AppEnvRotateMode = (typeof APP_ENV_ROTATE_MODES)[number];

/* ------------------------------------------------------------------------- *
 * Limits (plan §3.3:259–269; every number is spec FR-15/FR-17/FR-18/FR-28/FR-31/FR-34)
 * ------------------------------------------------------------------------- */

/** One value's byte ceiling (FR-18; plan §3.3:259). */
export const APP_ENV_VALUE_MAX_BYTES = 65_536 as const;

/** Total stored bytes per App Work (FR-31; plan §3.3:260). */
export const APP_ENV_TOTAL_MAX_BYTES = 1_048_576 as const;

/** Stored values per App Work, declared plus undeclared (FR-31; plan §3.3:261). */
export const APP_ENV_MAX_STORED = 300 as const;

/** A keypair public half's ceiling (FR-15; plan §3.3:262). */
export const APP_ENV_PUBLIC_HALF_MAX_BYTES = 16_384 as const;

/** The linear-time budget for one `pattern` evaluation (FR-17; plan §3.3:263). */
export const APP_ENV_PATTERN_BUDGET_MS = 50 as const;

/** Pasted `.env` text ceiling (FR-28; plan §3.3:264). */
export const APP_ENV_DOTENV_MAX_BYTES = 65_536 as const;

/** Pasted `.env` line ceiling (FR-28; plan §3.3:265). */
export const APP_ENV_DOTENV_MAX_LINES = 500 as const;

/** A generated value is produced within this window of the spec being applied (FR-9; plan §3.3:266). */
export const APP_ENV_GENERATE_SLA_MS = 60_000 as const;

/** Rotations per App Work per hour (FR-13; plan §3.3:267). */
export const APP_ENV_ROTATIONS_PER_HOUR = 10 as const;

/** `PUT` requests per minute per member (FR-34; plan §3.3:268). */
export const APP_ENV_PUTS_PER_MINUTE = 30 as const;

/** Template nesting depth, re-checked at resolution (plan §2.2:125, §3.3:269). */
export const APP_ENV_TEMPLATE_MAX_DEPTH = 10 as const;

/** A `chars` generator's byte window (FR-10: `length` 16–256). */
export const APP_ENV_CHARS_MIN_LENGTH = 16 as const;

/** A `chars` generator's upper length — FR-10. */
export const APP_ENV_CHARS_MAX_LENGTH = 256 as const;

/** A `base64` generator's byte window (FR-10: `bytes` 16–128). */
export const APP_ENV_BASE64_MIN_BYTES = 16 as const;

/** A `base64` generator's upper byte count — FR-10. */
export const APP_ENV_BASE64_MAX_BYTES = 128 as const;

/** A UUID v4 value's exact length (FR-10). */
export const APP_ENV_UUID_LENGTH = 36 as const;

/** The shortest value the redactor bothers to replace (plan §4.2:370). */
export const APP_ENV_REDACT_MIN_CHARS = 6 as const;

/* ------------------------------------------------------------------------- *
 * Generator and resolution fingerprints (plan §2.2:127–141, §4.3:397)
 * ------------------------------------------------------------------------- */

/**
 * The generator fingerprint recorded on the row: `${kind}:${bytes|length}:${alphabet?}`
 * or `keypair:${type}:${format}[:${passwordEnv}]` (plan §4.3:397).
 *
 * A change here is what sets `generatorChanged` (FR-12) — it never regenerates
 * a value implicitly.
 */
export function appEnvGeneratorFingerprint(generate: {
	readonly kind: AppEnvGeneratorKind;
	readonly bytes?: number;
	readonly length?: number;
	readonly alphabet?: AppEnvAlphabet;
	readonly keypair?: {
		readonly type: AppEnvKeypairType;
		readonly format?: AppEnvKeypairFormat;
		readonly passwordEnv?: string;
	};
}): string {
	if (generate.kind === 'keypair') {
		const keypair = generate.keypair;
		const type = keypair?.type ?? 'ed25519';
		const format = keypair?.format ?? APP_ENV_KEYPAIR_DEFAULT_FORMAT;
		const suffix = format === 'pkcs12' && keypair?.passwordEnv ? `:${keypair.passwordEnv}` : '';
		return `keypair:${type}:${format}${suffix}`;
	}
	if (generate.kind === 'uuid') return 'uuid';
	if (generate.kind === 'chars')
		return `chars:${generate.length ?? APP_ENV_CHARS_MIN_LENGTH}:${generate.alphabet ?? 'alnum'}`;
	// base64 / hex
	return `${generate.kind}:${generate.bytes ?? APP_ENV_BASE64_MIN_BYTES}`;
}

/** A stored value's fingerprint: `v<version>`, incremented on every change (plan §2.2:138). */
export function appEnvStoredFingerprint(version: number): string {
	return `v${version}`;
}

/** A direct dependency output's fingerprint: `d<outputsVersion>` (plan §2.2:139). */
export function appEnvDependencyFingerprint(outputsVersion: number): string {
	return `d${outputsVersion}`;
}

/**
 * A secret template/`from` entry's fingerprint:
 * `t<sha256 over the template or reference text plus the sorted (placeholder,
 * fingerprint) pairs it resolved>` (plan §2.2:140).
 *
 * A hash of a secret **value** is never computed or persisted — only of the
 * template text and the fingerprints of what it resolved (plan §2.2:143).
 */
export function appEnvTemplateFingerprint(
	text: string,
	placeholders: readonly { readonly placeholder: string; readonly fingerprint: string }[]
): string {
	const sorted = placeholders
		.map((entry) => [entry.placeholder, entry.fingerprint] as const)
		.sort((left, right) => {
			if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
			if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
			return 0;
		});
	return `t${sorted.map(([placeholder, fingerprint]) => `${text}\u0000${placeholder}\u0000${fingerprint}`).join('\u0001')}`;
}

/** The keypair public half's env name: `<NAME>_PUBLIC` (FR-14, FR-15). */
export function appEnvPublicHalfName(name: string): string {
	return `${name}${APP_ENV_PUBLIC_HALF_SUFFIX}`;
}

/**
 * A dependency's generated-password token name, uppercased from the kind
 * (plan §4.6.1:447): `postgres` → `DEP_POSTGRES_PASSWORD`.
 */
export function appEnvDependencyPasswordToken(kind: string): string {
	return `${APP_ENV_DEP_PASSWORD_TOKEN_PREFIX}${kind.toUpperCase()}${APP_ENV_DEP_PASSWORD_TOKEN_SUFFIX}`;
}

/**
 * Is this keypair type usable in this format?
 *
 * `base64url-raw` is refused for RSA (FR-14, plan §3.3:248); `pkcs12` requires
 * `keypair.passwordEnv` naming a separate generated secret entry and is never
 * packed with an empty passphrase (Resolution R-11).
 */
export function appEnvKeypairFormatSupported(
	type: AppEnvKeypairType,
	format: AppEnvKeypairFormat,
	passwordEnv?: string
): boolean {
	if (format === 'base64url-raw') return (APP_ENV_KEYPAIR_RAW_TYPES as readonly string[]).includes(type);
	if (format === 'pkcs12') return passwordEnv !== undefined && passwordEnv.length > 0;
	return true;
}

/** True when an env name starts with a browser-exposed prefix (FR-20). */
export function hasAppEnvPublicPrefix(name: string): boolean {
	return APP_ENV_PUBLIC_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/* ------------------------------------------------------------------------- *
 * Validation refusal codes (plan §4.4:406–411)
 * ------------------------------------------------------------------------- */

/** The validation refusal codes of FR-19 / plan §4.4:409–410. */
export const APP_ENV_VALIDATION_REFUSAL_CODES = [
	'invalidName',
	'reservedName',
	'valueTooLarge',
	'controlCharacter',
	'lengthMismatch',
	'tooShort',
	'tooLong',
	'patternMismatch'
] as const;

/** A validation refusal code — plan §4.4:409–410. */
export type AppEnvValidationRefusalCode = (typeof APP_ENV_VALIDATION_REFUSAL_CODES)[number];

/** The line outcomes an `.env` import reports (FR-29, plan §4.5:419). */
export const APP_ENV_IMPORT_OUTCOMES = ['set', 'created', 'skipped', 'refused'] as const;

/** An `.env` import line outcome — FR-29. */
export type AppEnvImportOutcome = (typeof APP_ENV_IMPORT_OUTCOMES)[number];

/* ------------------------------------------------------------------------- *
 * API error codes and their message keys (plan §5:798-805, §8:907; APW07-G23)
 * ------------------------------------------------------------------------- */

/**
 * The API-level error codes the Environment routes answer with, and which are
 * not validation refusals — plan §5:798-802.
 *
 * The route each one belongs to is in the plan's error-code sentence; the two
 * that are easy to misplace are `secureStorageUnavailable`, which is a **503**
 * because the installation has no encryption key at all (so nothing can be
 * stored), and `rotateRateLimited`, which is the **429** of the 10-per-hour cap
 * (FR-13) and not a refusal of the request's content.
 */
export const APP_ENV_API_ERROR_CODES = [
	'generatedValueUseRotate',
	'neverRotateNotAcknowledged',
	'rotateConfirmationMismatch',
	'secureStorageUnavailable',
	'tooManyValues',
	'valuesTooLarge',
	'malformedLine',
	'rotateRateLimited'
] as const;

/** An API-level Environment error code — plan §5:798-802. */
export type AppEnvApiErrorCode = (typeof APP_ENV_API_ERROR_CODES)[number];

/**
 * Every code that carries copy under `dashboard.workDetail.appEnv.errors.*` —
 * the eight validation refusals of plan §4.4:409-410 **plus** the eight API
 * codes above, which is exactly the sixteen leaves plan §8:907 lists.
 *
 * The two lists are concatenated rather than re-typed so a refusal code can
 * never drift out of the error vocabulary: the split is by WHERE the refusal is
 * produced (validation vs. the route), not by what the person reads.
 */
export const APP_ENV_ERROR_CODES = [...APP_ENV_VALIDATION_REFUSAL_CODES, ...APP_ENV_API_ERROR_CODES] as const;

/** An Environment error code, validation or API — plan §8:907. */
export type AppEnvErrorCode = (typeof APP_ENV_ERROR_CODES)[number];

/**
 * One `dashboard.workDetail.appEnv.errors.<leaf>` leaf per code, with camelCase,
 * `.`-free leaves — plan §8:907, the same shape APW-06's
 * `APP_PRECONDITION_MESSAGE_LEAVES` uses.
 *
 * The map is a total `Record` over the union, so a code added without a leaf here
 * fails to compile, and T1's spec pins every leaf against
 * `apps/web/messages/en.json` (APW07-G23): a code without copy renders as a raw
 * identifier on the Environment table.
 */
export const APP_ENV_ERROR_MESSAGE_LEAVES = {
	invalidName: 'invalidName',
	reservedName: 'reservedName',
	valueTooLarge: 'valueTooLarge',
	controlCharacter: 'controlCharacter',
	lengthMismatch: 'lengthMismatch',
	tooShort: 'tooShort',
	tooLong: 'tooLong',
	patternMismatch: 'patternMismatch',
	generatedValueUseRotate: 'generatedValueUseRotate',
	neverRotateNotAcknowledged: 'neverRotateNotAcknowledged',
	rotateConfirmationMismatch: 'rotateConfirmationMismatch',
	secureStorageUnavailable: 'secureStorageUnavailable',
	tooManyValues: 'tooManyValues',
	valuesTooLarge: 'valuesTooLarge',
	malformedLine: 'malformedLine',
	rotateRateLimited: 'rotateRateLimited'
} as const satisfies Record<AppEnvErrorCode, string>;

/** The i18n subtree every Environment error code's copy lives under — plan §8:907. */
export const APP_ENV_ERROR_MESSAGE_KEY_PREFIX = 'dashboard.workDetail.appEnv.errors' as const;

/**
 * The ONE message key of an error code (plan §5:802-805: "carries exactly one
 * message key").
 *
 * Callers render from this resolver rather than building the path themselves, so
 * there is one implementation of the code→key mapping and the T1 spec can pin it.
 */
export function appEnvErrorMessageKey(code: AppEnvErrorCode): string {
	return `${APP_ENV_ERROR_MESSAGE_KEY_PREFIX}.${APP_ENV_ERROR_MESSAGE_LEAVES[code]}`;
}

/* ------------------------------------------------------------------------- *
 * Resolution (plan §2.2:110–150)
 * ------------------------------------------------------------------------- */

/** Why an entry could not be resolved. Reasons come from plan §2.2:121–125. */
export const APP_ENV_UNRESOLVED_REASONS = [
	/** A required `prompt` entry has no stored value — plan §2.2:119. */
	'missingRequired',
	/** A `from: domains.primary.*` entry with no primary domain — plan §2.2:121. */
	'noPrimaryDomain',
	/** A build-phase `deps.<kind>.<out>` with no build service of that kind — plan §2.2:122, FR-22. */
	'noBuildService',
	/** A runtime `deps.<kind>.<out>` whose row is not `ready` — plan §2.2:122. */
	'dependencyNotReady',
	/** `platform.smtp.*` / `components.*.internalUrl` are not available at build — plan §2.2:123–124. */
	'notAvailableAtBuild',
	/** `platform.smtp.*` with no relay selected — plan §2.2:123. */
	'relayNotSelected',
	/** A template that cannot be resolved, failing closed — plan §4.6.1:449. */
	'templateUnresolvable'
] as const;

/** Why an entry is unresolved — plan §2.2:121–125, §4.6.1:449. */
export type AppEnvUnresolvedReason = (typeof APP_ENV_UNRESOLVED_REASONS)[number];

/**
 * One resolved entry: `{ name, value, secret, fingerprint }` (plan §2.2:127).
 *
 * `fingerprint` is the per-name fingerprint of the §2.2 rule — `v<version>` for
 * stored values, `d<outputsVersion>` for dependency outputs, `t<…>` for a secret
 * template, `sha256(value)` only for non-secret or build-service values.
 */
export interface AppEnvResolvedValue {
	name: string;
	value: string;
	secret: boolean;
	fingerprint: string;
}

/**
 * One unresolved entry: `{ name, reason, ref }` — **never a value**
 * (plan §2.2:129).
 */
export interface AppEnvUnresolved {
	name: string;
	reason: AppEnvUnresolvedReason;
	/** The reference text that could not resolve, e.g. `deps.postgres.url`. */
	ref: string | null;
}

/**
 * The per-name fingerprint map APW-05 and APW-06 persist — it has exactly the
 * same keys as `values` (plan §2.2:143–146).
 */
export type AppEnvFingerprints = Record<string, string>;

/** The result of one resolution pass (plan §2.2:113). */
export interface AppEnvResolution {
	values: AppEnvResolvedValue[];
	unresolved: AppEnvUnresolved[];
	fingerprints: AppEnvFingerprints;
}

/** Where a resolution writes its values — APW-06's namespace Secret or APW-05's `EW_` secrets. */
export const APP_ENV_RESOLUTION_TARGETS = ['cluster', 'runner'] as const;

/** A resolution target — plan §4.6.1:444–447. */
export type AppEnvResolutionTarget = (typeof APP_ENV_RESOLUTION_TARGETS)[number];

/** What an entry's `source` is in the App spec (plan §3.3:274). */
export const APP_ENV_DECLARED_SOURCES = ['generate', 'from', 'template', 'prompt', 'value'] as const;

/** The `source` of a declared env entry, or `undeclared` for an owner-set extra name. */
export type AppEnvEntrySource = (typeof APP_ENV_DECLARED_SOURCES)[number] | 'undeclared';

/* ------------------------------------------------------------------------- *
 * The Environment table row (plan §3.3:271–294)
 * ------------------------------------------------------------------------- */

/** One Environment-table row — the view of FR-1/FR-2, `list(workId, viewer)`. */
export interface AppEnvEntryView {
	name: string;
	/** False for an undeclared name the owner set (FR-1). */
	declared: boolean;
	source: AppEnvEntrySource;
	/** `null` for an undeclared entry that has no App spec origin. */
	origin: AppEnvOrigin | null;
	/** Set when a stored value shadows a derived or default entry (FR-3). */
	overrides: 'derived' | 'default' | null;
	secret: boolean;
	phase: AppEnvPhase;
	required: boolean;
	set: boolean;
	description: string | null;
	group: string | null;
	/** The `from`/`template` text from the App spec — public by construction (FR-5). */
	reference: string | null;
	/** Only for `value` entries, which are never secret (FR-5, APW-03 R8). */
	specValue: string | null;
	validation: { length?: number; minLength?: number; maxLength?: number; hasPattern: boolean } | null;
	generator: { kind: AppEnvGeneratorKind; keypairFormat?: AppEnvKeypairFormat; rotate: AppEnvRotateMode } | null;
	/** True when the App spec's generator differs from the one the value was made with (FR-12). */
	generatorChanged: boolean;
	/** True when a secret's name carries a browser-exposed prefix (FR-20). */
	publicPrefixWarning: boolean;
	/** The keypair public half — the ONE value the platform shows (FR-15). */
	publicValue: string | null;
	/** Compared against `WorkBuild.buildValueFingerprints` (FR-24, plan §2.2:136–150). */
	changedSinceBuild: boolean;
	/** Compared against `appRender.envFingerprints` (FR-24, plan §2.2:136–150). */
	changedSinceDeploy: boolean;
	updatedAt: string | null;
	updatedBy: { userId: string; name: string } | null;
}

/* ------------------------------------------------------------------------- *
 * The runner recipe (plan §4.6.1:439–449) — the normative value-free union
 * ------------------------------------------------------------------------- */

/**
 * The sources a runner recipe entry may have.
 *
 * `generate | literal | template | prompted` are the four APW-07 plan §4.6.1
 * names; `derived` is added because APW-05's `verify-plan.schema.json:202`
 * permits it and that schema is what `ajv` validates before dispatch — the
 * union is the superset of both, nothing is dropped (Resolution R-26).
 */
export const APP_ENV_RECIPE_SOURCES = ['generate', 'literal', 'template', 'prompted', 'derived'] as const;

/** A runner recipe entry's source — plan §4.6.1:447, verify-plan.schema.json:202. */
export type AppEnvRecipeSource = (typeof APP_ENV_RECIPE_SOURCES)[number];

/** The token kinds a recipe template may carry — plan §4.6.1:447. */
export const APP_ENV_RECIPE_TOKEN_KINDS = ['gen', 'prompted', 'dep'] as const;

/** A recipe template token's kind — plan §4.6.1:447. */
export type AppEnvRecipeTokenKind = (typeof APP_ENV_RECIPE_TOKEN_KINDS)[number];

/** One token inside a recipe template (`{{gen:NAME}}`, `{{prompted:NAME}}`, `{{dep:…}}`). */
export interface AppEnvRecipeToken {
	kind: AppEnvRecipeTokenKind;
	/** The token's inner name, e.g. `DEP_POSTGRES_PASSWORD`. */
	name: string;
	/** The literal placeholder the runner replaces, e.g. `{{gen:DEP_POSTGRES_PASSWORD}}`. */
	placeholder: string;
}

/** A `generate` recipe entry's parameters — plan §4.6.1:447, §4.3:379–397. */
export interface AppEnvRecipeGenerateSpec {
	kind: AppEnvGeneratorKind;
	bytes?: number;
	length?: number;
	alphabet?: AppEnvAlphabet;
	keypair?: { type: AppEnvKeypairType; format?: AppEnvKeypairFormat; passwordEnv?: string };
}

/** A `template` recipe entry's payload — plan §4.6.1:447. */
export interface AppEnvRecipeTemplateSpec {
	text: string;
	tokens: AppEnvRecipeToken[];
}

/** A `derived` recipe entry's reference — verify-plan.schema.json:225. */
export interface AppEnvRecipeDerivedSpec {
	reference: string;
}

/** A `prompted` recipe entry's payload — plan §4.6.1:447. */
export interface AppEnvRecipePromptedSpec {
	required: boolean;
}

/**
 * One value-free recipe entry (plan §4.6.1:447, "the normative discriminated
 * union defined in `packages/contracts/src/apps/app-env.ts`, added by
 * APW07-G18").
 *
 * The runner materialises it — `openssl rand` for `base64`/`hex`/`chars`/`uuid`,
 * `openssl genpkey` for `keypair` in the declared format, prompted values from
 * the single `EW_VERIFY__PROMPTED` secret — into a `0600` env file under
 * `$RUNNER_TEMP`, and shreds that file afterwards. Values are never echoed and
 * `set +x` is on throughout (plan §4.10:1028–1033).
 */
export type AppEnvRecipeEntry =
	| { name: string; secret?: boolean; source: 'generate'; spec: AppEnvRecipeGenerateSpec }
	| { name: string; secret?: boolean; source: 'literal'; spec: { value: string } }
	| { name: string; secret?: boolean; source: 'template'; spec: AppEnvRecipeTemplateSpec }
	| { name: string; secret?: boolean; source: 'prompted'; spec: AppEnvRecipePromptedSpec }
	| { name: string; secret?: boolean; source: 'derived'; spec: AppEnvRecipeDerivedSpec };

/**
 * The fixed container-host grammar of the runner recipe, so APW-05 and APW-07
 * cannot drift (plan §4.6.1:447).
 *
 * Kinds map to the throwaway containers of APW-05 plan §4.10:1052. `minio` is
 * the IMAGE of the object-storage container and never its host name; the host
 * is `object-storage`, and the access key is APW-05's build-service default.
 */
export const APP_ENV_RUNNER_RECIPE_ENDPOINTS = {
	postgres: { host: 'postgres', port: 5432, user: 'ever-works-build', database: 'app' },
	redis: { host: 'redis', port: 6379, password: '' },
	objectStorage: { host: 'object-storage', port: 9000, accessKeyId: 'ever-works-build' }
} as const;

/** A runner recipe dependency endpoint's kind — plan §4.6.1:447. */
export type AppEnvRunnerRecipeEndpointKind = keyof typeof APP_ENV_RUNNER_RECIPE_ENDPOINTS;

/**
 * The runner's build-service outputs for a dependency kind, all non-secret and
 * flagged `fromBuildService` (plan §4.6.2:455–462).
 *
 * `postgres`'s `url` and `directUrl` are identical here
 * (`postgresql://user:password@127.0.0.1:5432/database?sslmode=disable`), the
 * object-storage `bucket.<name>` output is emitted once per declared bucket, and
 * `smtp`'s `from` is `build@example.invalid` — an RFC 2606 placeholder, never a
 * real address (plan §4.6.2:462).
 */
export const APP_ENV_BUILD_SERVICE_OUTPUTS = {
	postgres: { host: '127.0.0.1', port: 5432, region: null, from: null },
	redis: { host: '127.0.0.1', port: 6379, region: null, from: null },
	objectStorage: { host: '127.0.0.1', port: 9000, region: 'us-east-1', from: null },
	smtp: { host: '127.0.0.1', port: 1025, region: null, from: 'build@example.invalid' }
} as const;

/** A build-service output kind — plan §4.6.2:457–462. */
export type AppEnvBuildServiceOutputKind = keyof typeof APP_ENV_BUILD_SERVICE_OUTPUTS;

/** `objectStorage`'s build-service region — plan §4.6.2:461. */
export const APP_ENV_BUILD_SERVICE_OBJECT_STORAGE_REGION = 'us-east-1' as const;

/** `smtp`'s build-service from-address — plan §4.6.2:462 (RFC 2606 placeholder). */
export const APP_ENV_BUILD_SERVICE_SMTP_FROM = 'build@example.invalid' as const;

/** The build-service flag APW-05's `BuildValue` carries so a value is excluded from `EW_SECRET_NAMES`. */
export const APP_ENV_BUILD_SERVICE_VALUE_FLAG = 'fromBuildService' as const;
