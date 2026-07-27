import type { Logger } from './logger';

/**
 * Node credential storage (audit A45).
 *
 * The heartbeat secret used to live as plaintext JSON in the config
 * file, protected by a 0600 chmod that was SKIPPED entirely on Windows.
 * That is two problems: any process running as the operator could read
 * it, and on Windows nothing was even attempted.
 *
 * The fix has two halves, and this module is the first:
 *
 *   1. **Prefer the OS keychain.** macOS Keychain, Windows Credential
 *      Manager and the Linux Secret Service all exist precisely for
 *      this, and all three are reached through ONE vendor SDK
 *      (`@napi-rs/keyring`). We do not hand-roll crypto: a
 *      passphrase-less local encryption scheme keyed by a file sitting
 *      next to the ciphertext protects nobody, and inventing one would
 *      be strictly worse than the keychain the platform already ships.
 *
 *   2. **Fall back loudly.** Headless Linux boxes routinely have no
 *      Secret Service, and containers never do. Refusing to run there
 *      would break the very deployment shape `apps/node` exists for.
 *      So the file fallback stays — with a warning on every load and
 *      save, and with a real owner-only ACL on Windows rather than a
 *      silently skipped chmod (see `config-store.ts`).
 *
 * The SDK is resolved at RUNTIME through an injected loader rather than
 * imported at module scope. A native addon that fails to build must
 * degrade this one feature, not take down a node that would otherwise
 * heartbeat perfectly well.
 */

/** Keychain service name every node credential is filed under. */
export const KEYCHAIN_SERVICE = 'ever-works-node';

/** Anything that can hold one named secret. */
export interface SecretStore {
	/** Human-readable name for logs ("OS keychain", "config file"). */
	readonly label: string;
	get(account: string): Promise<string | null>;
	set(account: string, secret: string): Promise<void>;
	delete(account: string): Promise<void>;
}

/**
 * Structural shape of `@napi-rs/keyring`'s `Entry`. Declared here rather
 * than imported so the optional native dependency never becomes a
 * compile-time requirement.
 */
export interface KeyringEntryLike {
	getPassword(): string;
	setPassword(password: string): void;
	deletePassword(): boolean;
}

export interface KeyringModuleLike {
	Entry: new (service: string, account: string) => KeyringEntryLike;
}

/**
 * Resolve the keyring SDK, or null when it is not installed / not
 * loadable on this host. Injected everywhere so tests never touch a
 * real keychain.
 */
export type KeyringLoader = () => KeyringModuleLike | null;

/**
 * The production loader: a plain `require` of the optional dependency,
 * guarded. `@napi-rs/keyring` ships prebuilt binaries for the platforms
 * `apps/node` targets; when one is missing (musl on an exotic arch, a
 * `--no-optional` install, a container without a Secret Service) the
 * require throws and we degrade instead of crashing.
 */
export const defaultKeyringLoader: KeyringLoader = () => {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const loaded = require('@napi-rs/keyring') as Partial<KeyringModuleLike>;
		return typeof loaded?.Entry === 'function' ? (loaded as KeyringModuleLike) : null;
	} catch {
		return null;
	}
};

/**
 * A {@link SecretStore} backed by the OS credential manager.
 *
 * Every method is fail-soft: a keychain that is present but locked, or
 * that refuses a write, reports failure to the caller (null / throw)
 * rather than pretending. `createSecretStore` is what turns that into
 * the file fallback.
 */
export function createKeychainSecretStore(keyring: KeyringModuleLike): SecretStore {
	return {
		label: 'OS keychain',
		get: async (account) => {
			try {
				const value = new keyring.Entry(KEYCHAIN_SERVICE, account).getPassword();
				return typeof value === 'string' && value ? value : null;
			} catch {
				// No entry, or a locked keychain. Both read as "absent".
				return null;
			}
		},
		set: async (account, secret) => {
			new keyring.Entry(KEYCHAIN_SERVICE, account).setPassword(secret);
		},
		delete: async (account) => {
			try {
				new keyring.Entry(KEYCHAIN_SERVICE, account).deletePassword();
			} catch {
				// Already gone — deleting a missing credential is a success.
			}
		}
	};
}

/** The message an operator sees when the credential lands on disk. */
export const FILE_FALLBACK_WARNING =
	'No OS keychain is available on this host — the node credential will be stored in the config file. ' +
	'The file is restricted to the current user (0600 on POSIX, an owner-only ACL on Windows), but any ' +
	'process running as this user can read it. Install `@napi-rs/keyring` and a Secret Service ' +
	'(gnome-keyring / kwallet) to keep the credential out of the filesystem.';

export interface ResolveSecretStoreOptions {
	loadKeyring?: KeyringLoader;
	logger?: Logger;
	/** Set to skip the keychain entirely (operator override / tests). */
	disabled?: boolean;
}

/**
 * Pick the strongest available store.
 *
 * Returns null when the credential has to live in the config file, and
 * warns ONCE, loudly, when it does — a silent downgrade to plaintext is
 * exactly the failure this audit item is about.
 */
export function resolveSecretStore(options: ResolveSecretStoreOptions = {}): SecretStore | null {
	if (options.disabled) {
		options.logger?.warn(`Keychain storage disabled by configuration. ${FILE_FALLBACK_WARNING}`);
		return null;
	}
	const keyring = (options.loadKeyring ?? defaultKeyringLoader)();
	if (!keyring) {
		options.logger?.warn(FILE_FALLBACK_WARNING);
		return null;
	}
	return createKeychainSecretStore(keyring);
}

/** Env var an operator sets to force the file fallback. */
export const DISABLE_KEYCHAIN_ENV = 'EVER_WORKS_NODE_DISABLE_KEYCHAIN';

/** True when the operator has explicitly opted out of the keychain. */
export function keychainDisabledByEnv(env: Record<string, string | undefined>): boolean {
	const value = env[DISABLE_KEYCHAIN_ENV];
	return typeof value === 'string' && ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}
