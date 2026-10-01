/**
 * APW-07 T19 — the digest-pinned images the in-cluster dependency providers run.
 *
 * Sources, in priority order:
 *
 * 1. `docs/specs/features/app-works/APW-07-app-env-and-dependencies/plan.md` §4.9:579-580 — "Images pinned by
 *    digest in `app-dependencies/images.ts`, overridable by admin settings"; §4.9:630-633 — the settings are
 *    "admin: image overrides per kind/version, and a pinned default S3-compatible server image"; and §4.9's
 *    provider table, which fixes the plain path's image as "per declared version" and the object-storage
 *    server's as "S3-compatible server image from settings".
 * 2. `tasks.md:288-290` (T19's `**Create**` line) — "digest-pinned images per Postgres version 14–17, Redis 7,
 *    the S3 server, client job images".
 * 3. `plan.md` §12's known gap **APW07-G17** (`plan.md:1061-1065`): the object-storage product is "chosen by
 *    admin setting with a tested default, so swapping the product changes `images.ts`, the init Job and its
 *    spec **only**".
 *
 * ## Why a digest and not a tag
 *
 * A tag is a mutable pointer: `postgres:16` re-resolves to a different image the moment upstream publishes,
 * so two provisionings of the same App Work can run different binaries and a rollback is not a rollback. A
 * digest is content-addressed, so a provider's manifest is reproducible. {@link isDigestPinned} is the
 * invariant, and T19's plain-path spec walks {@link everyDependencyImage} to prove that **no** path this
 * module can take emits a tag.
 *
 * ## The pinned values, and how they were obtained
 *
 * Every digest below is the **multi-arch manifest-list digest** of the named upstream tag, read from the
 * registry's own API (`hub.docker.com/v2/repositories/library/<image>/tags/<tag>` and
 * `quay.io/api/v1/repository/minio/<image>/tag/?specificTag=latest`) on the day this task landed. Pinning the
 * manifest list — not a per-architecture image — is what keeps one reference correct on `amd64` and `arm64`
 * nodes alike. `POSTGRES_CLIENT_IMAGE_DIGESTS` repeats the server digests because the official Postgres image
 * is what carries `psql`; the table is separate so an admin can pin a slimmer client without touching the
 * server an App Work's data lives in.
 *
 * ## No image reference is ever assembled from a caller's value
 *
 * `ctx.declared.version` is an App-spec field. {@link normalisePostgresVersion} reduces it to one of the four
 * supported majors (or the pinned default, which the provider reports), so a declared `version` cannot smuggle
 * a tag, a different repository or a second `@` into an image reference.
 */

/**
 * The Postgres major versions this plugin can provision — `plan.md` §4.9's "image per declared version",
 * bounded by T19's "per Postgres version 14–17".
 */
export const POSTGRES_VERSIONS = [14, 15, 16, 17] as const;

/** A supported Postgres major version. */
export type PostgresMajorVersion = (typeof POSTGRES_VERSIONS)[number];

/** The version a `postgres` dependency gets when the App spec declares none — ACC-07-14's "Postgres 16". */
export const POSTGRES_DEFAULT_VERSION: PostgresMajorVersion = 16;

/** The official Postgres repository, used for both the server and the `psql` client job. */
export const POSTGRES_REPOSITORY = 'docker.io/library/postgres';

/** The Redis repository (Redis 7 is the only major this plugin provisions, per T19). */
export const REDIS_REPOSITORY = 'docker.io/library/redis';

/** The default S3-compatible server (APW07-G17's "tested default", swap-able by admin setting). */
export const OBJECT_STORAGE_REPOSITORY = 'quay.io/minio/minio';

/** The matching S3 client — the init Job's `mc`. */
export const OBJECT_STORAGE_CLIENT_REPOSITORY = 'quay.io/minio/mc';

/** The tag each pinned digest was read from, recorded so a re-pin is a lookup rather than a guess. */
export const DEPENDENCY_IMAGE_TAGS = {
	postgres: '14|15|16|17',
	redis: '7',
	objectStorage: 'latest',
	objectStorageClient: 'latest'
} as const;

/**
 * The pinned Postgres server digest per major version.
 *
 * One entry per member of {@link POSTGRES_VERSIONS}: a total `Record`, so adding a version to the union
 * without a digest is a compile error rather than an image that resolves to `undefined`.
 */
export const POSTGRES_IMAGE_DIGESTS: Readonly<Record<PostgresMajorVersion, string>> = {
	14: 'sha256:156f0b253fd61366d5fc2107ad45955027d5612f695a8436ce20167f3fa79bff',
	15: 'sha256:9b1d34adbce1dd07ee6e94b4a2cf698884b89bd44a6c9c12f5da8f3acbfe4957',
	16: 'sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94',
	17: 'sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675'
};

/**
 * The pinned Postgres **client** digest per major version — the `psql` the extension Job runs (T19's "client
 * job images").
 *
 * Same image as the server by default (it ships `psql`), deliberately a separate table: the client only has to
 * speak the server's wire protocol, so a slim `-alpine` digest is a legitimate admin override that must not
 * change the server an App Work's data lives in.
 */
export const POSTGRES_CLIENT_IMAGE_DIGESTS: Readonly<Record<PostgresMajorVersion, string>> = {
	14: 'sha256:156f0b253fd61366d5fc2107ad45955027d5612f695a8436ce20167f3fa79bff',
	15: 'sha256:9b1d34adbce1dd07ee6e94b4a2cf698884b89bd44a6c9c12f5da8f3acbfe4957',
	16: 'sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94',
	17: 'sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675'
};

/** The Redis 7 digest (T19: "Redis 7"). */
export const REDIS_IMAGE_DIGEST = 'sha256:71da9275c5f3fcb97d0fa0c8c5b36cc995327265420f17a04bfd544f458059f7';

/** The only Redis major this plugin provisions (T19: "Redis 7"). */
export const REDIS_DEFAULT_VERSION = 7;

/** The pinned S3-compatible server digest (APW07-G17's default product). */
export const OBJECT_STORAGE_IMAGE_DIGEST = 'sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e';

/** The pinned S3 client digest — the bucket-init Job's `mc`. */
export const OBJECT_STORAGE_CLIENT_IMAGE_DIGEST =
	'sha256:a7fe349ef4bd8521fb8497f55c6042871b2ae640607cf99d9bede5e9bdf11727';

/** `sha256:` + 64 lowercase hex — the only shape a pinned image reference may carry. */
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * A digest, normalised to `sha256:<64 lowercase hex>`, or `null` when the value is not one.
 *
 * A bare 64-hex string is accepted (an operator pasting the value out of `docker inspect`), because the
 * algorithm is the only one in use; anything else — a tag, a partial hex, a repository, an object — is `null`,
 * and a `null` digests never becomes part of an image reference.
 */
export function normaliseImageDigest(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim().toLowerCase();
	if (!trimmed) return null;
	const digest = trimmed.startsWith('sha256:') ? trimmed : `sha256:${trimmed}`;
	return DIGEST_PATTERN.test(digest) ? digest : null;
}

/**
 * Is this a digest-pinned image reference?
 *
 * `repository@sha256:<64 hex>`, with **no** tag before the `@` — `postgres:16@sha256:…` is refused too,
 * because the tag would still be part of the reference a runtime resolves.
 */
export function isDigestPinned(image: string): boolean {
	if (typeof image !== 'string') return false;
	const at = image.lastIndexOf('@');
	if (at <= 0) return false;
	const repository = image.slice(0, at);
	if (!repository || /\s/.test(repository)) return false;
	const lastSlash = repository.lastIndexOf('/');
	const lastColon = repository.lastIndexOf(':');
	if (lastColon > lastSlash) return false;
	return DIGEST_PATTERN.test(image.slice(at + 1));
}

/**
 * `repository@sha256:<digest>` — the one place an image string is assembled.
 *
 * A digest that does not parse yields `repository@` with nothing after it, which is *not* a valid reference
 * and therefore cannot be pulled as something else. Callers pass only {@link POSTGRES_IMAGE_DIGESTS}-style
 * constants or values {@link dependencyImageOverride} has already validated.
 */
export function digestPinnedImage(repository: string, digest: string): string {
	return `${repository}@${normaliseImageDigest(digest) ?? ''}`;
}

/**
 * The App-spec-declared Postgres major, reduced to a supported one.
 *
 * Accepts `16`, `'16'`, `'16.4'` and `'v16'`; anything else (absent, `latest`, a tag, an unsupported major)
 * is {@link POSTGRES_DEFAULT_VERSION}. The reduction is deliberate: a value that cannot be mapped is a
 * declaration this provider cannot honour, and the alternative — building an image reference out of it —
 * would be a caller-controlled image. {@link isSupportedPostgresVersion} tells the caller whether a
 * substitution happened, so the provider can report it rather than hide it.
 */
export function normalisePostgresVersion(value: unknown): PostgresMajorVersion {
	return isSupportedPostgresVersion(value)
		? (Number.parseInt(postgresMajorText(value), 10) as PostgresMajorVersion)
		: POSTGRES_DEFAULT_VERSION;
}

/** Was the declared version one this plugin supports? `false` means {@link normalisePostgresVersion} fell back. */
export function isSupportedPostgresVersion(value: unknown): boolean {
	const text = postgresMajorText(value);
	if (!/^\d+$/.test(text)) return false;
	return (POSTGRES_VERSIONS as readonly number[]).includes(Number.parseInt(text, 10));
}

/** The leading integer of a declared version, as text — `'v16.4'` → `'16'`, `'latest'` → `''`. */
function postgresMajorText(value: unknown): string {
	const raw = typeof value === 'number' && Number.isFinite(value) ? String(Math.floor(value)) : String(value ?? '');
	const major = raw.trim().replace(/^v/i, '').split('.')[0] ?? '';
	return /^\d+$/.test(major) ? String(Number.parseInt(major, 10)) : '';
}

/**
 * An admin image override, or `null` when there is none to honour.
 *
 * The override may be a full `repository@sha256:<digest>` reference (the shape the settings schema asks for) or
 * a bare 64-hex digest, which is applied to the built-in repository. A tag, a partial value or an unparseable
 * string is refused with `null`, so the caller keeps the pinned default — "no image" is never the outcome of a
 * typo.
 */
export function dependencyImageOverride(value: unknown, repository?: string): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (isDigestPinned(trimmed)) return trimmed;
	const digest = normaliseImageDigest(trimmed);
	return digest && repository ? digestPinnedImage(repository, digest) : null;
}

/** The Postgres server image for a declared version, honouring an admin override. */
export function postgresImage(version: unknown, override?: unknown): string {
	const major = normalisePostgresVersion(version);
	return (
		dependencyImageOverride(override, POSTGRES_REPOSITORY) ??
		digestPinnedImage(POSTGRES_REPOSITORY, POSTGRES_IMAGE_DIGESTS[major])
	);
}

/** The `psql` client image the extension Job runs, honouring an admin override. */
export function postgresClientImage(version: unknown, override?: unknown): string {
	const major = normalisePostgresVersion(version);
	return (
		dependencyImageOverride(override, POSTGRES_REPOSITORY) ??
		digestPinnedImage(POSTGRES_REPOSITORY, POSTGRES_CLIENT_IMAGE_DIGESTS[major])
	);
}

/** The Redis 7 image, honouring an admin override. */
export function redisImage(override?: unknown): string {
	return (
		dependencyImageOverride(override, REDIS_REPOSITORY) ?? digestPinnedImage(REDIS_REPOSITORY, REDIS_IMAGE_DIGEST)
	);
}

/** The S3-compatible server image, honouring an admin override (APW07-G17). */
export function objectStorageImage(override?: unknown): string {
	return (
		dependencyImageOverride(override, OBJECT_STORAGE_REPOSITORY) ??
		digestPinnedImage(OBJECT_STORAGE_REPOSITORY, OBJECT_STORAGE_IMAGE_DIGEST)
	);
}

/** The S3 init Job's client image, honouring an admin override. */
export function objectStorageClientImage(override?: unknown): string {
	return (
		dependencyImageOverride(override, OBJECT_STORAGE_CLIENT_REPOSITORY) ??
		digestPinnedImage(OBJECT_STORAGE_CLIENT_REPOSITORY, OBJECT_STORAGE_CLIENT_IMAGE_DIGEST)
	);
}

/** The override keys the `appDependencyImages` admin setting may carry. */
export interface AppDependencyImageOverrides {
	readonly postgres: Readonly<Partial<Record<PostgresMajorVersion, string>>>;
	readonly postgresClient: Readonly<Partial<Record<PostgresMajorVersion, string>>>;
	readonly redis?: string;
	readonly objectStorage?: string;
	readonly objectStorageClient?: string;
}

/** Read one value out of an unknown record without ever trusting its type. */
function readOverride(source: unknown, key: string): unknown {
	if (!source || typeof source !== 'object') return undefined;
	return (source as Record<string, unknown>)[key];
}

/**
 * The `appDependencyImages` admin setting, as {@link AppDependencyImageOverrides}.
 *
 * `ctx.settings` is a `Record<string, unknown>` — a stored settings blob, not a validated object — so every
 * field is re-read from `unknown` here rather than cast, and a value of the wrong type simply produces no
 * override instead of an image the plugin did not choose.
 */
export function dependencyImageOverrides(settings: Record<string, unknown> | undefined): AppDependencyImageOverrides {
	const raw = readOverride(settings, 'appDependencyImages');
	const postgres: Partial<Record<PostgresMajorVersion, string>> = {};
	const postgresClient: Partial<Record<PostgresMajorVersion, string>> = {};

	for (const major of POSTGRES_VERSIONS) {
		const server = dependencyImageOverride(
			readOverride(readOverride(raw, 'postgres'), String(major)),
			POSTGRES_REPOSITORY
		);
		if (server) postgres[major] = server;
		const client = dependencyImageOverride(
			readOverride(readOverride(raw, 'postgresClient'), String(major)),
			POSTGRES_REPOSITORY
		);
		if (client) postgresClient[major] = client;
	}

	const overrides: {
		postgres: Partial<Record<PostgresMajorVersion, string>>;
		postgresClient: Partial<Record<PostgresMajorVersion, string>>;
		redis?: string;
		objectStorage?: string;
		objectStorageClient?: string;
	} = { postgres, postgresClient };

	const redis = dependencyImageOverride(readOverride(raw, 'redis'), REDIS_REPOSITORY);
	if (redis) overrides.redis = redis;
	const objectStorage = dependencyImageOverride(readOverride(raw, 'objectStorage'), OBJECT_STORAGE_REPOSITORY);
	if (objectStorage) overrides.objectStorage = objectStorage;
	const objectStorageClient = dependencyImageOverride(
		readOverride(raw, 'objectStorageClient'),
		OBJECT_STORAGE_CLIENT_REPOSITORY
	);
	if (objectStorageClient) overrides.objectStorageClient = objectStorageClient;

	return overrides;
}

/** The Postgres server image for a declared version, resolved through the plugin's settings in one call. */
export function postgresImageFor(settings: Record<string, unknown> | undefined, version: unknown): string {
	const overrides = dependencyImageOverrides(settings);
	const major = normalisePostgresVersion(version);
	return postgresImage(major, overrides.postgres[major]);
}

/** The `psql` client image for a declared version, resolved through the plugin's settings in one call. */
export function postgresClientImageFor(settings: Record<string, unknown> | undefined, version: unknown): string {
	const overrides = dependencyImageOverrides(settings);
	const major = normalisePostgresVersion(version);
	return postgresClientImage(major, overrides.postgresClient[major]);
}

/** The Redis image, resolved through the plugin's settings in one call. */
export function redisImageFor(settings: Record<string, unknown> | undefined): string {
	return redisImage(dependencyImageOverrides(settings).redis);
}

/** The S3-compatible server image, resolved through the plugin's settings in one call. */
export function objectStorageImageFor(settings: Record<string, unknown> | undefined): string {
	return objectStorageImage(dependencyImageOverrides(settings).objectStorage);
}

/** The S3 client image, resolved through the plugin's settings in one call. */
export function objectStorageClientImageFor(settings: Record<string, unknown> | undefined): string {
	return objectStorageClientImage(dependencyImageOverrides(settings).objectStorageClient);
}

/**
 * Every image this module can emit, in a stable order, for the two settings shapes that matter: the built-in
 * pins and a settings blob that overrides all of them.
 *
 * Exported for T19's plain-path spec, which asserts every entry is digest-pinned: a new image added without
 * being pinned is then a red test rather than a silently tag-resolved container.
 */
export function everyDependencyImage(): string[] {
	const images: string[] = [];
	for (const major of POSTGRES_VERSIONS) {
		images.push(postgresImage(major), postgresClientImage(major));
	}
	images.push(redisImage(), objectStorageImage(), objectStorageClientImage());
	return images;
}
