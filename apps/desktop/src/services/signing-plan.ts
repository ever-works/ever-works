/**
 * Code-signing resolution for packaged desktop builds.
 *
 * Signing material never lives in the repository: CI injects it from
 * repository secrets. This module turns whatever is present in the environment
 * into an explicit plan — which env vars electron-builder should see, which
 * config overrides to pass, and (crucially) a LOUD warning when a build
 * degrades to unsigned so nobody ships an unsigned installer by accident.
 *
 * Forks and pull requests from forks never receive secrets, so the unsigned
 * path is a first-class, supported outcome rather than a failure.
 *
 * Values are never logged — only the NAMES of the variables involved.
 */

export type SigningTargetOs = 'win' | 'mac' | 'linux';

/** Repository secrets, mapped to env var names by the packaging workflow. */
export const SIGNING_ENV_VARS = {
	windowsCertificate: 'DESKTOP_WINDOWS_CERTIFICATE_BASE64',
	windowsCertificatePassword: 'DESKTOP_WINDOWS_CERTIFICATE_PASSWORD',
	macCertificate: 'DESKTOP_MACOS_CERTIFICATE_BASE64',
	macCertificatePassword: 'DESKTOP_MACOS_CERTIFICATE_PASSWORD',
	appleId: 'DESKTOP_APPLE_ID',
	appleAppSpecificPassword: 'DESKTOP_APPLE_APP_SPECIFIC_PASSWORD',
	appleTeamId: 'DESKTOP_APPLE_TEAM_ID'
} as const;

export interface SigningPlan {
	os: SigningTargetOs;
	/** True when electron-builder will actually sign the artifacts. */
	signed: boolean;
	/** True when macOS notarization credentials are also present. */
	notarize: boolean;
	/** False for platforms where signing does not apply (Linux). */
	supported: boolean;
	/** Env vars to hand electron-builder (values copied from the source env). */
	env: Record<string, string>;
	/** Extra `-c.<path>=<value>` CLI arguments. */
	configArgs: string[];
	/** Names of the missing secrets that caused a degrade (never values). */
	missing: string[];
	/** Loud, human-readable line to print when the build degrades to unsigned. */
	warning?: string;
}

type EnvLike = Record<string, string | undefined>;

function present(env: EnvLike, name: string): boolean {
	const value = env[name];
	return typeof value === 'string' && value.trim() !== '';
}

function missingOf(env: EnvLike, names: string[]): string[] {
	return names.filter((name) => !present(env, name));
}

function unsignedWarning(os: SigningTargetOs, missing: string[]): string {
	return [
		`UNSIGNED BUILD (${os}): code-signing secrets are not available, so the installer will NOT be signed.`,
		`Missing repository secrets: ${missing.join(', ')}.`,
		'Users will see an OS publisher warning. This is expected for forks and pull requests;',
		'release builds must run with the signing secrets configured.'
	].join(' ');
}

/**
 * Resolve the signing plan for one target OS from an environment snapshot.
 * Pure: no filesystem, no process access.
 */
export function resolveSigningPlan(os: SigningTargetOs, env: EnvLike): SigningPlan {
	if (os === 'linux') {
		// electron-builder does not sign AppImage/deb artifacts; nothing to degrade.
		return { os, signed: false, notarize: false, supported: false, env: {}, configArgs: [], missing: [] };
	}

	if (os === 'win') {
		const required = [SIGNING_ENV_VARS.windowsCertificate, SIGNING_ENV_VARS.windowsCertificatePassword];
		const missing = missingOf(env, required);
		if (missing.length > 0) {
			return {
				os,
				signed: false,
				notarize: false,
				supported: true,
				// Stops electron-builder from picking up an unrelated certificate
				// that happens to be installed on the build machine.
				env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
				configArgs: [],
				missing,
				warning: unsignedWarning(os, missing)
			};
		}
		return {
			os,
			signed: true,
			notarize: false,
			supported: true,
			env: {
				// electron-builder accepts base64 certificate content directly in *_CSC_LINK.
				WIN_CSC_LINK: env[SIGNING_ENV_VARS.windowsCertificate] as string,
				WIN_CSC_KEY_PASSWORD: env[SIGNING_ENV_VARS.windowsCertificatePassword] as string
			},
			configArgs: [],
			missing: []
		};
	}

	const required = [SIGNING_ENV_VARS.macCertificate, SIGNING_ENV_VARS.macCertificatePassword];
	const missing = missingOf(env, required);
	if (missing.length > 0) {
		return {
			os,
			signed: false,
			notarize: false,
			supported: true,
			env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
			configArgs: ['-c.mac.notarize=false'],
			missing,
			warning: unsignedWarning(os, missing)
		};
	}

	const notarizeVars = [
		SIGNING_ENV_VARS.appleId,
		SIGNING_ENV_VARS.appleAppSpecificPassword,
		SIGNING_ENV_VARS.appleTeamId
	];
	const notarizeMissing = missingOf(env, notarizeVars);
	const notarize = notarizeMissing.length === 0;

	const plan: SigningPlan = {
		os,
		signed: true,
		notarize,
		supported: true,
		env: {
			CSC_LINK: env[SIGNING_ENV_VARS.macCertificate] as string,
			CSC_KEY_PASSWORD: env[SIGNING_ENV_VARS.macCertificatePassword] as string
		},
		configArgs: [`-c.mac.notarize=${notarize}`],
		missing: notarizeMissing
	};

	if (notarize) {
		plan.env.APPLE_ID = env[SIGNING_ENV_VARS.appleId] as string;
		plan.env.APPLE_APP_SPECIFIC_PASSWORD = env[SIGNING_ENV_VARS.appleAppSpecificPassword] as string;
		plan.env.APPLE_TEAM_ID = env[SIGNING_ENV_VARS.appleTeamId] as string;
	} else {
		plan.warning = [
			'SIGNED BUT NOT NOTARIZED (mac): the app is code-signed, but Apple notarization credentials are absent,',
			`so Gatekeeper will still warn on first launch. Missing repository secrets: ${notarizeMissing.join(', ')}.`
		].join(' ');
	}

	return plan;
}

/** Map a Node.js `process.platform` value to a packaging target OS. */
export function platformToTargetOs(platform: string): SigningTargetOs {
	if (platform === 'win32') {
		return 'win';
	}
	if (platform === 'darwin') {
		return 'mac';
	}
	return 'linux';
}

/** One-line, secret-free summary of a plan, suitable for CI logs. */
export function describeSigningPlan(plan: SigningPlan): string {
	if (!plan.supported) {
		return `[${plan.os}] code signing does not apply to this platform — artifacts are unsigned by design.`;
	}
	if (plan.signed && plan.notarize) {
		return `[${plan.os}] signing: ENABLED, notarization: ENABLED.`;
	}
	if (plan.signed) {
		return `[${plan.os}] signing: ENABLED, notarization: DISABLED.`;
	}
	return `[${plan.os}] signing: DISABLED (degraded to an unsigned build).`;
}
