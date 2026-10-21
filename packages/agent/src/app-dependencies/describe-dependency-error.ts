import { redactSecrets } from '../utils/secret-scan';

/**
 * One log line for a failure on the App dependency path — the error's name, its `code` (a
 * plugin's `K8sPluginError` code, an `ApiException`'s HTTP status, a socket's `ECONNREFUSED`),
 * its message, and the same for each `cause` (and an `AggregateError`'s first error) below it.
 *
 * ## Why this exists
 *
 * The provision runner and `AppDependenciesService` used to log `error.name` alone, so a prod run
 * read `failed / clusterUnreachable` with nothing that said *what* failed: a refused namespace
 * write, a TLS error, a DNS miss and an empty plugin registry all printed `Error`. The reason a
 * row carries stays the contract's closed union; this is for the operator's log only.
 *
 * ## What it never prints
 *
 * The credential these calls are made with is a kubeconfig — a bearer token (a JWT for a
 * ServiceAccount), inline PEM material and base64 `*-data` fields. A Kubernetes client error does
 * not normally echo it, but a thrown value is not something this file controls, so every part is:
 *
 * 1. passed through the repo's shared scanner (`redactSecrets`: PEM blocks, JWTs, `Bearer …`,
 *    prefixed tokens);
 * 2. stripped of kubeconfig credential fields (`token:`, `client-key-data:`, `password:` …) and of
 *    any base64 run long enough to be key or certificate material;
 * 3. whitespace-collapsed and cut to {@link MAX_PART_CHARS}, the chain to {@link MAX_CAUSE_DEPTH}.
 *
 * The stack is never included — it is noise in a one-line warning, and the message is what names
 * the cause.
 */
export function describeDependencyError(error: unknown): string {
    const parts: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = error;

    for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined; depth++) {
        if (current !== null && typeof current === 'object') {
            if (seen.has(current)) break;
            seen.add(current);
        }
        parts.push(describeOne(current));
        current = nextCause(current);
    }

    return parts.join(' <- caused by ');
}

/** How many `cause` hops are followed below the error itself. */
export const MAX_CAUSE_DEPTH = 4;

/** The longest one link of the chain may be, after redaction. */
export const MAX_PART_CHARS = 400;

const REDACTED = '[redacted]';

/** A kubeconfig credential field and its value (YAML or JSON spelling). */
const KUBECONFIG_CREDENTIAL_FIELD =
    /(["']?\b(?:token|client-key-data|client-certificate-data|certificate-authority-data|password|client-key|client-certificate)\b["']?\s*[:=]\s*)(["']?)[^\s"',}]+\2/gi;

/**
 * A base64 run long enough to be key or certificate material (a kubeconfig's `*-data` value is
 * one unbroken line of thousands). `-`, `_` and `.` are left out so resource names and API paths
 * — `helper-pod-create-pvc-<uuid>`, `rbac.authorization.k8s.io` — are never mistaken for one.
 */
const LONG_BASE64_RUN = /[A-Za-z0-9+/]{80,}={0,2}/g;

function describeOne(value: unknown): string {
    if (value instanceof Error) {
        const code = codeOf(value);
        const head = code ? `${value.name} [${code}]` : value.name;
        const message = redact(value.message);
        return message ? `${head}: ${message}` : head;
    }
    if (typeof value === 'string') {
        return redact(value) || 'empty string';
    }
    return `a non-Error value (${value === null ? 'null' : typeof value})`;
}

function nextCause(value: unknown): unknown {
    if (!value || typeof value !== 'object') return undefined;
    const carried = value as { cause?: unknown; errors?: unknown };
    if (carried.cause !== undefined) return carried.cause;
    if (Array.isArray(carried.errors) && carried.errors.length > 0) return carried.errors[0];
    return undefined;
}

function codeOf(error: Error): string | null {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) return code.trim().slice(0, 64);
    if (typeof code === 'number' && Number.isFinite(code)) return String(code);
    return null;
}

function redact(text: string | undefined): string {
    if (!text) return '';
    const scanned = redactSecrets(String(text)).cleaned;
    const cleaned = scanned
        .replace(KUBECONFIG_CREDENTIAL_FIELD, (_match, key: string) => `${key}${REDACTED}`)
        .replace(LONG_BASE64_RUN, REDACTED)
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.length > MAX_PART_CHARS ? `${cleaned.slice(0, MAX_PART_CHARS)}…` : cleaned;
}
