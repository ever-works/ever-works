import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
    classifyCwd,
    expandArgs,
    expandEnvValues,
    expandPlaceholders,
    isReservedEnvKey,
    PLUGIN_DATA_PLACEHOLDER,
    PLUGIN_ROOT_PLACEHOLDER,
    resolveRealPath,
    type ExpansionContext,
    type McpStdioServer,
} from '@ever-works/agent-plugins';
import { isWithin } from './package-data-dir.service';

/**
 * Turns a validated stdio server declaration into the exact arguments a
 * subprocess would be spawned with (T30).
 *
 * Deliberately a PURE function returning a plan, with no `spawn` in sight.
 * Everything that makes launching a package's own executable dangerous is
 * decided here — the environment it can see, the binary that actually runs,
 * the directory it starts in — and each of those is a value that can be
 * asserted on directly. A function that spawned as it decided could only be
 * tested by running the thing it is supposed to be deciding whether to run.
 */

/** The base environment. Everything else must be earned. */
const INHERITED_KEYS = ['PATH', 'HOME', 'TMPDIR', 'USERPROFILE', 'SystemRoot'] as const;

export interface LaunchPlan {
    /** Absolute path to the executable, or a bare name to resolve through PATH. */
    readonly command: string;
    readonly args: readonly string[];
    /** Complete environment. NOT merged with `process.env` by the caller. */
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string;
    /** True when `command` is a bare name the OS resolves through PATH. */
    readonly resolvesThroughPath: boolean;
}

export interface LaunchContext {
    /** Filesystem-resolved package root. */
    readonly packageRoot: string;
    /** Filesystem-resolved `${PLUGIN_DATA}` directory, already created. */
    readonly pluginData: string;
}

export class LaunchRefused extends Error {
    constructor(
        message: string,
        readonly code: string,
    ) {
        super(message);
        this.name = 'LaunchRefused';
    }
}

/**
 * Build the environment a package's server process will see.
 *
 * ## Built from nothing, not filtered from `process.env`
 *
 * The API process environment holds `DATABASE_URL`, `AUTH_SECRET`, every
 * `PLUGIN_*` API key and the platform encryption key. A denylist over that
 * would have to enumerate every secret that exists now and every one added
 * later — and the day someone adds a secret without updating the denylist,
 * every installed package can read it. Starting from `{}` inverts the
 * default: a new platform secret is invisible to packages unless somebody
 * deliberately adds it here.
 *
 * `PATH` is inherited because resolving a bare command is the point of
 * allowing bare commands at all; `HOME` and `TMPDIR` because a great many
 * runtimes fail confusingly without them.
 *
 * ## Order is a control
 *
 * The package's own `env` is applied SECOND and the two reserved keys LAST,
 * so a package cannot point `PLUGIN_ROOT` at somewhere else by declaring it —
 * and cannot override `PATH` to shadow the binary that is about to run.
 */
export function buildLaunchEnv(
    declared: Readonly<Record<string, string>> | undefined,
    ctx: LaunchContext,
): Record<string, string> {
    const env: Record<string, string> = {};

    for (const key of INHERITED_KEYS) {
        const value = process.env[key];
        if (value !== undefined && value !== '') {
            env[key] = value;
        }
    }
    env.PATH ??= '/usr/local/bin:/usr/bin:/bin';
    env.HOME ??= homedir();
    env.TMPDIR ??= tmpdir();

    const expansion: ExpansionContext = {
        pluginRoot: ctx.packageRoot,
        pluginData: ctx.pluginData,
    };

    for (const [key, value] of Object.entries(expandEnvValues(declared, expansion))) {
        // The library rejects a reserved key at validation time, so reaching
        // this is a bug rather than a hostile package — but the assignment
        // below would silently win over the authoritative values set after
        // the loop, so it is refused rather than trusted.
        if (isReservedEnvKey(key)) {
            throw new LaunchRefused(
                `Package declared the reserved environment variable "${key}".`,
                'reserved-env-key',
            );
        }
        env[key] = value;
    }

    // LAST, and unconditionally: these are the client's statement of where the
    // package lives, not the package's.
    env[PLUGIN_ROOT_PLACEHOLDER.slice(2, -1)] = ctx.packageRoot;
    env[PLUGIN_DATA_PLACEHOLDER.slice(2, -1)] = ctx.pluginData;

    return env;
}

/**
 * Resolve the command token to something safe to execute.
 *
 * The spec permits exactly two shapes, and the distinction is the whole
 * control:
 *
 * - a **bare name** (`node`, `uvx`) resolves through `PATH`, so it can only
 *   ever run something the operator installed in the image;
 * - a **`./`-relative path** runs a file the PACKAGE ships, so it must be
 *   proved to sit inside the package root after symlinks are followed.
 *
 * Anything else — an absolute path, a `../` escape, a Windows drive, a token
 * containing a separator — is refused. An absolute path is refused even
 * though it looks harmless, because it names a binary neither the operator
 * nor the package can be said to have chosen deliberately.
 */
export async function resolveCommand(
    command: string,
    packageRoot: string,
): Promise<{ command: string; resolvesThroughPath: boolean }> {
    const token = command.trim();

    if (token === '') {
        throw new LaunchRefused('Empty command.', 'empty-command');
    }

    if (token.startsWith('./')) {
        const candidate = resolve(packageRoot, token);
        // `resolve` collapses `..` LEXICALLY, before any symlink is followed,
        // so the real path has to be recomputed and checked — the same trap
        // the conformance library documents for package paths.
        const real = await resolveRealPath(candidate);
        const realRoot = await resolveRealPath(packageRoot);
        if (!isWithin(realRoot, real)) {
            throw new LaunchRefused(
                `Command "${token}" resolves to "${real}", outside the package root.`,
                'command-escapes-package',
            );
        }
        return { command: real, resolvesThroughPath: false };
    }

    if (isAbsolute(token) || /[\\/]/u.test(token) || /^[a-zA-Z]:/u.test(token)) {
        throw new LaunchRefused(
            `Command "${token}" must be a bare name resolved through PATH, or a ./-relative ` +
                `path inside the package.`,
            'command-not-a-single-token',
        );
    }

    return { command: token, resolvesThroughPath: true };
}

/**
 * Resolve `cwd` per spec 7.2.1, or default to the package root.
 *
 * Each of the three permitted anchors is contained against the root it names:
 * a `${PLUGIN_DATA}`-anchored value must stay inside the data directory, not
 * merely inside *a* directory. Checking both against the package root would
 * pass a value that escapes into someone else's data.
 */
export async function resolveCwd(
    declared: string | undefined,
    ctx: LaunchContext,
): Promise<string> {
    if (declared === undefined || declared === '') {
        return ctx.packageRoot;
    }

    const anchor = classifyCwd(declared);
    if (anchor === undefined) {
        throw new LaunchRefused(
            `cwd "${declared}" is not one of the permitted forms.`,
            'cwd-not-permitted',
        );
    }

    const expanded = expandPlaceholders(declared, {
        pluginRoot: ctx.packageRoot,
        pluginData: ctx.pluginData,
    });
    const candidate = anchor === 'plugin-relative' ? join(ctx.packageRoot, declared) : expanded;

    const expectedRoot = anchor === 'plugin-data' ? ctx.pluginData : ctx.packageRoot;
    const real = await resolveRealPath(resolve(candidate));
    const realRoot = await resolveRealPath(expectedRoot);

    if (!isWithin(realRoot, real)) {
        throw new LaunchRefused(
            `cwd "${declared}" resolves to "${real}", outside "${realRoot}".`,
            'cwd-escapes-anchor',
        );
    }

    return real;
}

/** Everything needed to spawn one stdio server, with nothing left to decide. */
export async function buildLaunchPlan(
    server: McpStdioServer,
    ctx: LaunchContext,
): Promise<LaunchPlan> {
    const { command, resolvesThroughPath } = await resolveCommand(server.command, ctx.packageRoot);
    const expansion: ExpansionContext = {
        pluginRoot: ctx.packageRoot,
        pluginData: ctx.pluginData,
    };

    return {
        command,
        args: expandArgs(server.args, expansion),
        env: buildLaunchEnv(server.env, ctx),
        cwd: await resolveCwd(server.cwd, ctx),
        resolvesThroughPath,
    };
}
