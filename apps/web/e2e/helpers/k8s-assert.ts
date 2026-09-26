/**
 * Read-only Kubernetes assertions for the App Works acceptance harness
 * (APW-13 T10, `docs/specs/features/app-works/APW-13-golden-paths/tasks.md:154`).
 *
 * Two safety properties this module exists to hold (ACC-13-17, `spec.md:551`;
 * plan §8.2, `plan.md:502`):
 *
 *   1. **A Secret is never read out of the cluster, only its key set.** Nothing
 *      in this module returns, stores, logs or compares a Secret *value*:
 *      `secretKeys` maps the object to key names, and `assertNoSecretValues`
 *      throws for any caller-supplied Secret object that still carries values,
 *      so a value cannot be handed to an assertion, a snapshot or an artefact
 *      by mistake.
 *   2. **Namespace deletion is allow-listed twice over.** `deleteTestNamespace`
 *      refuses unless the kube context is one of `APW_E2E_USER_CLUSTER_CONTEXT`
 *      / `APW_E2E_APPS_TIER_CONTEXT` *and* the namespace name starts with
 *      `apw-e2e-`. With neither variable set (the default), every deletion is
 *      refused — the allow-list is opt-in, never ambient.
 *
 * Every command runs through an injectable runner, so the unit spec
 * (`e2e/helpers/__tests__/k8s-assert.unit.spec.ts`) stubs `kubectl` and never
 * touches a cluster. The default runner spawns the real binary.
 */

import { spawn } from 'node:child_process';

export interface KubectlResult {
    stdout: string;
    stderr: string;
    code: number;
}

/**
 * A `kubectl` invocation. `input` is written to stdin when present (unused by
 * this module's reads, part of the injectable contract).
 */
export type KubectlRunner = (args: string[], input?: string) => Promise<KubectlResult>;

/** The label the platform puts on every object it creates for an App Work. */
export const WORK_LABEL_KEY = 'ever-works.io/part-of';

/** Every namespace the harness may create and may therefore remove. */
export const TEST_NAMESPACE_PREFIX = 'apw-e2e-';

/** The two contexts a harness run may delete in; both must be named explicitly. */
export const ALLOWED_CONTEXT_ENV_VARS = [
    'APW_E2E_USER_CLUSTER_CONTEXT',
    'APW_E2E_APPS_TIER_CONTEXT',
] as const;

let runner: KubectlRunner | undefined;

function defaultRunner(args: string[], input?: string): Promise<KubectlResult> {
    return new Promise<KubectlResult>((resolve, reject) => {
        const child = spawn('kubectl', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ stdout, stderr, code: code ?? -1 });
        });
        // A `kubectl` that cannot be spawned closes the pipe under us; the
        // process's own `error` event above is the failure that matters.
        child.stdin.on('error', () => undefined);
        child.stdin.end(input ?? '');
    });
}

/** Replace the runner (a stub in unit specs); `undefined` restores the real one. */
export function setKubectlRunner(next?: KubectlRunner): void {
    runner = next;
}

/** The runner currently in force. */
export function getKubectlRunner(): KubectlRunner {
    return runner ?? defaultRunner;
}

/** The allow-listed kube contexts, from the two documented variables. */
export function allowedContexts(): string[] {
    return ALLOWED_CONTEXT_ENV_VARS.flatMap((name) =>
        (process.env[name] ?? '')
            .split(/[,\s]+/)
            .map((value) => value.trim())
            .filter((value) => value.length > 0),
    );
}

/** `kubectl config current-context` — the context a bare call would use. */
export async function currentContext(): Promise<string> {
    const result = await getKubectlRunner()(['config', 'current-context']);
    const context = result.stdout.trim();
    if (result.code !== 0 || !context) {
        throw new Error(
            `k8s-assert: could not read the current kube context (exit ${result.code}): ` +
                `${result.stderr.trim() || 'no output'}`,
        );
    }
    return context;
}

function contextArgs(context?: string): string[] {
    const value = context?.trim();
    return value ? ['--context', value] : [];
}

function scopeArgs(input: { namespace?: string; context?: string }): string[] {
    const namespace = input.namespace?.trim();
    return namespace
        ? ['-n', namespace, ...contextArgs(input.context)]
        : ['-A', ...contextArgs(input.context)];
}

async function kubectlJson<T>(label: string, args: string[]): Promise<T> {
    const result = await getKubectlRunner()(args);
    if (result.code !== 0) {
        throw new Error(
            `k8s-assert: ${label} failed (exit ${result.code}): ` +
                `${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
        );
    }
    const text = result.stdout.trim();
    if (!text) throw new Error(`k8s-assert: ${label} returned no output`);
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`k8s-assert: ${label} did not return JSON: ${text.slice(0, 200)}`);
    }
}

export interface WorkLabelQuery {
    /** The Work's slug — the value of `ever-works.io/part-of`. */
    workSlug: string;
    /** Namespace; omitted reads every namespace (`-A`). */
    namespace?: string;
    /** kube context; omitted uses the caller's current context. */
    context?: string;
}

export interface K8sObjectRef {
    kind: string;
    name: string;
    namespace: string;
    /** ISO 8601 `metadata.creationTimestamp`. */
    createdAt: string;
    labels: Record<string, string>;
}

interface K8sList {
    items?: Array<{
        kind?: string;
        metadata?: {
            name?: string;
            namespace?: string;
            creationTimestamp?: string;
            labels?: Record<string, string>;
        };
    }>;
}

function toRefs(kind: string, list: K8sList): K8sObjectRef[] {
    return (list.items ?? []).map((item) => ({
        kind: item.kind ?? kind,
        name: item.metadata?.name ?? '',
        namespace: item.metadata?.namespace ?? '',
        createdAt: item.metadata?.creationTimestamp ?? '',
        labels: item.metadata?.labels ?? {},
    }));
}

/**
 * `kubectl get <kind> -l ever-works.io/part-of=<slug> -o json` — the objects the
 * platform created for one App Work.
 */
export async function listObjectsByWorkLabel(
    query: WorkLabelQuery & { kind: string },
): Promise<K8sObjectRef[]> {
    const kind = query.kind?.trim();
    const workSlug = query.workSlug?.trim();
    if (!kind) throw new Error('k8s-assert.listObjectsByWorkLabel: `kind` is required');
    if (!workSlug) throw new Error('k8s-assert.listObjectsByWorkLabel: `workSlug` is required');
    const list = await kubectlJson<K8sList>(`get ${kind} -l ${WORK_LABEL_KEY}=${workSlug}`, [
        'get',
        kind,
        '-l',
        `${WORK_LABEL_KEY}=${workSlug}`,
        ...scopeArgs(query),
        '-o',
        'json',
    ]);
    return toRefs(kind, list);
}

/** `metadata.creationTimestamp` of the App Work's Ingress, or `null` when absent. */
export async function getIngressCreatedAt(query: WorkLabelQuery): Promise<string | null> {
    const ingresses = await listObjectsByWorkLabel({ ...query, kind: 'ingress' });
    const first = ingresses
        .map((ingress) => ingress.createdAt)
        .filter((createdAt) => createdAt.length > 0)
        .sort()[0];
    return first ?? null;
}

/**
 * `status.completionTime` of one Job, or `null` while it has not completed.
 * Reads a named Job rather than a list: a completion time is an observation
 * about one object, and a list would silently pass on the wrong one.
 */
export async function getJobCompletedAt(input: {
    name: string;
    namespace: string;
    context?: string;
}): Promise<string | null> {
    const name = input.name?.trim();
    const namespace = input.namespace?.trim();
    if (!name) throw new Error('k8s-assert.getJobCompletedAt: `name` is required');
    if (!namespace) throw new Error('k8s-assert.getJobCompletedAt: `namespace` is required');
    const job = await kubectlJson<{ status?: { completionTime?: string } }>(`get job ${name}`, [
        'get',
        'job',
        name,
        '-n',
        namespace,
        ...contextArgs(input.context),
        '-o',
        'json',
    ]);
    return job.status?.completionTime ?? null;
}

export interface CronJobRef {
    name: string;
    namespace: string;
    schedule: string;
    suspend: boolean;
    lastScheduleTime: string | null;
}

/** Every CronJob of one App Work (by label) or of one namespace (T10). */
export async function listCronJobs(
    input: { workSlug?: string; namespace?: string; context?: string } = {},
): Promise<CronJobRef[]> {
    const workSlug = input.workSlug?.trim();
    if (!workSlug && !input.namespace?.trim()) {
        throw new Error('k8s-assert.listCronJobs: pass `workSlug` (App Work label) or `namespace`');
    }
    const args = ['get', 'cronjobs'];
    if (workSlug) args.push('-l', `${WORK_LABEL_KEY}=${workSlug}`);
    args.push(...scopeArgs(input), '-o', 'json');
    const list = await kubectlJson<{
        items?: Array<{
            metadata?: { name?: string; namespace?: string };
            spec?: { schedule?: string; suspend?: boolean };
            status?: { lastScheduleTime?: string };
        }>;
    }>(`get cronjobs${workSlug ? ` -l ${WORK_LABEL_KEY}=${workSlug}` : ''}`, args);
    return (list.items ?? []).map((item) => ({
        name: item.metadata?.name ?? '',
        namespace: item.metadata?.namespace ?? '',
        schedule: item.spec?.schedule ?? '',
        suspend: item.spec?.suspend === true,
        lastScheduleTime: item.status?.lastScheduleTime ?? null,
    }));
}

export interface SecretKeyList {
    namespace: string;
    name: string;
    /** Key names only — this module has no shape that can carry a value. */
    keys: string[];
}

interface SecretLike {
    metadata?: { name?: string; namespace?: string };
    data?: Record<string, unknown>;
    stringData?: Record<string, unknown>;
}

function keyNamesOf(secret: SecretLike): string[] {
    return Array.from(
        new Set([...Object.keys(secret.data ?? {}), ...Object.keys(secret.stringData ?? {})]),
    ).sort();
}

/**
 * The guard the module offers to callers: **throws** when a Secret object still
 * carries values, and returns the key names when it does not.
 *
 * A Secret read from a cluster always carries values, so this guard is for
 * objects crossing the harness's own boundary — a fixture, a parsed `-o json`
 * dump, a value a scenario wants to hand to an assertion. Refusing them is what
 * keeps ACC-13-16's "no secret in an artefact" true for anything built from
 * this module. It returns keys rather than `void` so a caller has to keep
 * thinking in key names.
 */
export function assertNoSecretValues(secret: unknown): string[] {
    const record = (secret ?? {}) as SecretLike;
    const carried = (['data', 'stringData'] as const).filter((field) => {
        const values = record[field];
        return values !== undefined && values !== null && Object.keys(values).length > 0;
    });
    if (carried.length > 0) {
        throw new Error(
            `k8s-assert: refusing to read Secret.${carried[0]} — this module handles Secret ` +
                'key names only; a value must never reach an assertion, a log or an artefact ' +
                '(ACC-13-17, spec.md:551).',
        );
    }
    return keyNamesOf(record);
}

/**
 * The key names of one Secret, read with
 * `kubectl get secret <name> -n <namespace> -o json`.
 *
 * This is the only Secret reader in the module and it is deliberately
 * lossy-by-construction: the parsed object goes straight through
 * {@link keyNamesOf}, which returns `Object.keys(...)` and nothing else, so no
 * value has a path out of this function. `assertNoSecretValues` is *not*
 * applied here — a cluster Secret legitimately carries values, and refusing it
 * would make the read impossible; the guard exists for objects a caller
 * supplies.
 */
export async function secretKeys(input: {
    name: string;
    namespace: string;
    context?: string;
}): Promise<SecretKeyList> {
    const name = input.name?.trim();
    const namespace = input.namespace?.trim();
    if (!name) throw new Error('k8s-assert.secretKeys: `name` is required');
    if (!namespace) throw new Error('k8s-assert.secretKeys: `namespace` is required');
    const secret = await kubectlJson<SecretLike>(`get secret ${name}`, [
        'get',
        'secret',
        name,
        '-n',
        namespace,
        ...contextArgs(input.context),
        '-o',
        'json',
    ]);
    return { namespace, name, keys: keyNamesOf(secret) };
}

/**
 * `kubectl delete namespace <name>` — the harness's one removal, and the only
 * one ACC-13-17 permits (plan §8.2, `plan.md:502`).
 *
 * Refuses (throws, before any command runs) unless the namespace starts with
 * `apw-e2e-` **and** the context is allow-listed. The context is the caller's
 * current one unless `context` says otherwise, so a run that drifted onto
 * another cluster refuses rather than deletes there.
 */
export async function deleteTestNamespace(
    name: string,
    options: { context?: string } = {},
): Promise<{ namespace: string; context: string; stdout: string; stderr: string; code: number }> {
    const namespace = String(name ?? '').trim();
    if (!namespace.startsWith(TEST_NAMESPACE_PREFIX)) {
        throw new Error(
            `k8s-assert.deleteTestNamespace: refusing "${namespace}" — a test namespace must ` +
                `start with "${TEST_NAMESPACE_PREFIX}" (ACC-13-17, spec.md:551).`,
        );
    }
    const context = options.context?.trim() || (await currentContext());
    const allowed = allowedContexts();
    if (!allowed.includes(context)) {
        throw new Error(
            `k8s-assert.deleteTestNamespace: refusing "${namespace}" — kube context ` +
                `"${context}" is not allow-listed; set APW_E2E_USER_CLUSTER_CONTEXT or ` +
                `APW_E2E_APPS_TIER_CONTEXT (currently: ${
                    allowed.length > 0 ? allowed.join(', ') : 'none'
                }).`,
        );
    }
    const result = await getKubectlRunner()([
        '--context',
        context,
        'delete',
        'namespace',
        namespace,
        '--wait=false',
    ]);
    if (result.code !== 0) {
        throw new Error(
            `k8s-assert.deleteTestNamespace: "${namespace}" failed (exit ${result.code}): ` +
                `${result.stderr.trim() || result.stdout.trim() || 'no output'}`,
        );
    }
    return { namespace, context, ...result };
}
