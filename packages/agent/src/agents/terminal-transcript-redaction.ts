import { redactSecrets } from '../utils/secret-scan';

/** Marker written in place of a credential-shaped value. */
export const TERMINAL_REDACTED = '[redacted secret]';

/**
 * Terminal-specific credential shapes, layered ON TOP of the repo's
 * canonical scanner (`utils/secret-scan.ts` — the same pattern set that
 * guards Agent files, Skill bodies and Task chat).
 *
 * The scanner catches PREFIXED tokens (`ghp_`, `sk-`, `xoxb-`, JWTs,
 * PEM blocks, …). A terminal stream leaks credentials in shapes the
 * scanner cannot see because the secret itself is opaque:
 *
 *   1. `export DEPLOY_TOKEN=hunter2hunter2`  — a shell env assignment
 *      where only the KEY tells you it's a secret.
 *   2. `git push https://user:pw@host/repo`  — URL userinfo, exactly how
 *      the workspace plugins inject per-operation credentials (they scrub
 *      it from their own logs for the same reason).
 *   3. `Authorization: Basic dXNlcjpwdw==`   — a header echoed by `curl -v`.
 *   4. `mysql -pS3cretPassword`              — the `-p<value>` flag form.
 *
 * Each pattern keeps the identifying prefix and masks only the value, so
 * a stored transcript still reads as a transcript.
 */
const TERMINAL_SECRET_PATTERNS: ReadonlyArray<{
    re: RegExp;
    replace: (...args: string[]) => string;
}> = [
    {
        // KEY=value where KEY looks secretish. Quoted or bare.
        re: /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|CREDENTIALS)[A-Za-z0-9_]*)(\s*=\s*)(["']?)([^\s"';|&]{4,})\3/gi,
        replace: (_m, key, eq, quote) => `${key}${eq}${quote}${TERMINAL_REDACTED}${quote}`,
    },
    {
        // scheme://user:password@host — mask the password only.
        re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]{1,256}):([^\s/@]{1,512})@/gi,
        replace: (_m, scheme, user) => `${scheme}${user}:${TERMINAL_REDACTED}@`,
    },
    {
        // Authorization: <scheme> <credential> (Bearer is also caught
        // by the shared scanner; Basic/Token/Digest are not).
        re: /\b(Authorization\s*:\s*)(Basic|Bearer|Token|Digest)\s+([^\s"']{4,})/gi,
        replace: (_m, header, scheme) => `${header}${scheme} ${TERMINAL_REDACTED}`,
    },
    {
        // -p<password> / --password=<value> / --token <value>
        re: /(--?(?:password|token|api[-_]?key|secret))([= ])(["']?)([^\s"';|&]{4,})\3/gi,
        replace: (_m, flag, sep, quote) => `${flag}${sep}${quote}${TERMINAL_REDACTED}${quote}`,
    },
];

export interface TerminalRedactionResult {
    /** Text safe to persist. */
    text: string;
    /** How many credential-shaped spans were masked. */
    redactions: number;
}

/**
 * Redaction chokepoint for terminal transcripts (streaming-terminal M9 /
 * founder decision D1: "tenant-scoped, **secret-redacted**,
 * retention-capped").
 *
 * Runs at the single output-ingest point — the internal batch publish
 * endpoint — BEFORE anything reaches storage. It never throws and never
 * returns a longer-than-input surprise: a pathological input at worst
 * ends up entirely masked.
 *
 * This is deliberately a *superset* wrapper rather than an edit to
 * `secret-scan.ts`: that module's patterns are shared with content
 * generation paths where a broader regex would corrupt legitimate text.
 * Terminal bytes have no such constraint — over-redaction here is a
 * transcript that reads slightly worse, under-redaction is a credential
 * in the database.
 */
export function redactTerminalText(input: string): TerminalRedactionResult {
    if (!input) {
        return { text: input ?? '', redactions: 0 };
    }

    let redactions = 0;
    let text = input;

    for (const { re, replace } of TERMINAL_SECRET_PATTERNS) {
        // Fresh RegExp per call — the module-level literals carry /g and
        // would otherwise share `lastIndex` across invocations.
        const pattern = new RegExp(re.source, re.flags);
        text = text.replace(pattern, (...args: string[]) => {
            redactions += 1;
            return replace(...args);
        });
    }

    // Shared scanner last: prefix-shaped tokens that survived (or were
    // never adjacent to a key/flag) get the same treatment every other
    // authoring surface in the platform gets.
    const scanned = redactSecrets(text);
    return { text: scanned.cleaned, redactions: redactions + scanned.redactions };
}
