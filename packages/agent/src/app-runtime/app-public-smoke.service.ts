/**
 * APW-06 T23 — the **public smoke service**: the platform's half of FR-36, and the classifier
 * FR-37 and S19 are written about.
 *
 * Spec: `APW-06-app-runtime/spec.md` FR-36 (`spec.md:411-416`, "every smoke check … runs twice per
 * Deployment: from inside the cluster … and over the public address"; "Smoke, job and scheduled
 * requests never follow redirects: a redirect is judged by its own status"), FR-37
 * (`spec.md:417-422`, the four classifications and "never response bodies beyond 200 characters,
 * and never a secret value"), FR-26 step 7 (`spec.md:380`, "Public smoke and self-address check |
 * 600 s on first publish, 180 s afterwards | Live with warnings (no rollback)"), FR-47
 * (`spec.md:476-481`, only `check_failed` is health-relevant), S19 (`spec.md:168-170`).
 * Plan: **§5.5** (`plan.md:800-803` — "Public smoke classification lives in the platform
 * (`AppPublicSmokeService`, redirects never followed): DNS lookup of the host ≠ ingress address →
 * `dns_not_pointing`; TLS handshake/name failure → `tls_not_ready`; connect timeout → `unreachable`;
 * response mismatch while the same check passed in-cluster → `check_failed` (health-relevant).
 * Only in-cluster failures and publish failures roll back."), **§5.3** (`plan.md:727-731`, the
 * numbers), **§4.8** (`plan.md:542-558`, the in-cluster runner this is the twin of), §9.3
 * (`plan.md:1291-1292`, the health poll uses "the public-smoke classifier"). Task text:
 * `tasks.md:410-418` (T23) — "requests with manual redirects, 1 MiB body cap, classification
 * `dns_not_pointing` / `tls_not_ready` / `unreachable` / `check_failed`, windows 600 s / 180 s,
 * retry every 10 s." Acceptance: **ACC-06-13** (S19), ACC-06-12, ACC-06-14.
 *
 * ## Where it sits
 *
 * It is the implementation behind `AppDeployHooks.verifyPublic`
 * (`packages/plugin/src/contracts/capabilities/app-deployment.types.ts:408-413`):
 *
 * ```
 * deployApp(input, credential, hooks)                       // the deployment plugin, §5.5 phase 7
 *   └─ hooks.verifyPublic({ urls, checks, windowSeconds })  // T25's orchestrator
 *        └─ AppPublicSmokeService.run({ ...req, workId })   ← this file
 * ```
 *
 * so {@link AppPublicSmokeRun} **extends** `AppSmokeRun`: the value this service resolves is
 * returned to the plugin unchanged (`app-deployer.ts:1611-1646`), which is why nothing here may
 * rename or reshape `checks` / `passed`.
 *
 * ## The four rules this file exists to keep
 *
 * 1. **Nothing is followed and nothing is trusted.** `redirect: 'manual'` on every request
 *    (FR-36), and a 3xx is judged by its own status exactly as the in-cluster runner judges it
 *    (`app-runner.script.ts:286`). The body is read through a cap of
 *    {@link APP_SMOKE_BODY_BYTES} (1 MiB) and the reader is cancelled at the cap, so a 1 GiB
 *    response never enters memory; **no response body leaves this service** — only a
 *    {@link APP_SMOKE_FOUND_CHARS}-character (`200`) excerpt of the string that failed, secret
 *    values scrubbed (`spec.md:422`).
 * 2. **A public failure never rolls a Deployment back** (§5.5:803, FR-26 step 7). Every failing
 *    check is a `warnings` entry on the Deployment; only `check_failed` is health-relevant
 *    (FR-37, §5.6 step 9's upstream-sync verdict reads exactly that distinction:
 *    `plan.md:845-847`). {@link AppPublicSmokeRun.healthRelevant} is that fact, and it is
 *    `check_failed` **while the same-named in-cluster check did not fail** — the same in-cluster
 *    results ride in on the request.
 * 3. **The window is the caller's, the retry is this file's.** `hooks.verifyPublic` passes
 *    `windowSeconds` (600 on the first publish, 180 afterwards, `app-deployer.ts:1621-1624`);
 *    when a caller passes none, {@link publicSmokeWindowSeconds} answers from
 *    `isFirstDeploymentOnCluster`. Between attempts this service waits
 *    {@link APP_SMOKE_RETRY_S} (10 s).
 * 4. **A DNS record that does not point here is named, not guessed.** §5.5's first rule compares
 *    the host's resolution against the address the cluster's ingress reported (§4.11's
 *    `ingressAddress`, recorded by `checkAppCluster`, plan §9.10:1593). When the two disagree the
 *    checks are classified `dns_not_pointing` **without a request being sent** — the answer S19
 *    needs ("the DNS record to create is shown"), and the reason a public smoke run cannot report
 *    "unreachable" for a record nobody has created yet.
 *
 * ## What this file deliberately is not
 *
 * It performs **only** public HTTP (and the DNS lookup that precedes it). It never runs a runner,
 * never touches a cluster, a database, a cache or an event bus, and it emits nothing: §5.7's
 * `app-smoke` job and §5.6's orchestrator are the callers that write `smokeResult` and emit
 * `app.smoke.*`. It reads no environment variable (R-5) and imports no plugin (the agent never
 * imports the k8s plugin, `plan.md:929-934`).
 *
 * ## The in-cluster twin, and the two places they must agree
 *
 * `packages/plugins/k8s/src/app/app-runner.script.ts` is the in-cluster half of the same check
 * list (`plan.md` §4.8). The agent may not import it, so three rules are spelled twice and pinned
 * by test on both sides:
 *
 * | Rule | Here | There |
 * | ---- | ---- | ----- |
 * | default expected status | {@link APP_SMOKE_DEFAULT_STATUS} (`200, 201, 204`) | `DEFAULT_STATUS`, `app-runner.script.ts:191` |
 * | default latency limit | {@link APP_SMOKE_DEFAULT_LATENCY_MS} (`10 000`) | `DEFAULT_LATENCY_MS`, `:192` |
 * | body cap / excerpt | `APP_SMOKE_BODY_BYTES` · `APP_SMOKE_FOUND_CHARS` | `MAX_BODY_BYTES` · `FOUND_CHARS`, `:186-187` |
 *
 * The two summaries are compared by `__tests__/app-public-smoke.service.spec.ts`, which reads that
 * script off disk for exactly that assertion.
 *
 * ## Provisional seams (each routed, none silent)
 *
 * - **The clock.** {@link AppPublicSmokeService.now} and {@link AppPublicSmokeService.sleep} are
 *   the two seams the window and the 10 s retry run on, so the spec proves a 600 s window without
 *   waiting 600 s. They are `protected` methods rather than an injected clock because nothing else
 *   in this epic needs one and a second Nest provider for `Date.now` would be noise.
 * - **DNS.** {@link AppPublicSmokeService.resolveHostAddresses} wraps `node:dns`. §6.1's shared
 *   helper (`packages/plugin/src/helpers/cluster-address-policy.ts`, APW06-G20, `tasks.md:1107`)
 *   owns **public-address** judgement, which is the wrong verdict here: a smoke host resolves
 *   through whatever the owner's DNS says, and this service only compares it against the ingress
 *   address it was given. When that helper lands, only this one method can change.
 * - **`fetch`.** {@link AppPublicSmokeService.fetchImpl} is the one place the global is reached
 *   for, which is what lets the spec drive an undici-shaped certificate error through the real
 *   classification path.
 * - **The in-cluster results.** `inCluster` is an **optional request field**, not a dependency of
 *   the smoke run: §5.6 passes them because it ran phase 5 moments earlier, and a caller that has
 *   none (a manual `app-smoke` re-run) simply gets `healthRelevant` decided without them.
 *
 * ## A test fixture this file does not add (reported, not hidden)
 *
 * T23's Test line asks for "local HTTPS server with a mismatched certificate → `tls_not_ready`".
 * A live mismatched-certificate server needs a PEM pair; this repository is public
 * (`app-works/README.md` §7 rule 10) and a committed private key is exactly what secret scanners
 * are for, so the suite proves that requirement in two real, deterministic halves instead of
 * committing one:
 *
 * 1. a **live TLS handshake failure** on a real socket (a server that answers the ClientHello with
 *    plaintext), through the real `fetch` path, classified `tls_not_ready`; and
 * 2. the **certificate-mismatch codes themselves** — `ERR_TLS_CERT_ALTNAME_INVALID`,
 *    `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED` — through
 *    {@link classifyPublicSmokeError}, and through the same injected-`fetch` path undici raises
 *    them on.
 *
 * Both assert the identical outcome the task names (`status: 'failed'`,
 * `classification: 'tls_not_ready'`); what is not committed is a key.
 */

import * as dns from 'node:dns';
import { isIP } from 'node:net';

import { Injectable, Logger } from '@nestjs/common';
import {
    APP_SMOKE_BODY_BYTES,
    APP_SMOKE_FOUND_CHARS,
    APP_SMOKE_PUBLIC_FIRST_WINDOW_S,
    APP_SMOKE_PUBLIC_WINDOW_S,
    APP_SMOKE_RETRY_S,
} from '@ever-works/contracts';
import type { AppSmokeInput, AppSmokeRun, CheckResult } from '@ever-works/plugin';
// The repository's own SSRF guard — see {@link AppPublicSmokeService.fetchImpl}. Imported from
// the agent-side re-export (`../utils/ssrf-guard`) rather than
// `@ever-works/plugin/helpers/ssrf-guard`, because `packages/plugin/src/helpers/index.ts:6`
// deliberately does not re-export it from the barrel and this package already owns the
// forwarding module.
import { safeFetchWithDnsPin } from '../utils/ssrf-guard';

/* -------------------------------------------------------------------------- *
 * Vocabulary this file adds
 * -------------------------------------------------------------------------- */

/**
 * The four classifications of §5.5:803 / FR-37, in the plan's own order.
 *
 * Spelled as a union here rather than derived from `CheckResult['classification']` because
 * `strictNullChecks` is off in this package and a derived alias stops being a union the moment the
 * plugin's member is optional — the spec asserts the two are mutually assignable.
 */
export type AppPublicSmokeClassification =
    | 'dns_not_pointing'
    | 'tls_not_ready'
    | 'unreachable'
    | 'check_failed';

/**
 * The classifications that are **warnings** and never count toward health — §5.6 step 9
 * (`plan.md:845-847`: "`dns_not_pointing`, `tls_not_ready` and `unreachable` are warnings and do
 * not count"), FR-37, ACC-06-13.
 */
export const APP_PUBLIC_SMOKE_WARNING_CODES: readonly AppPublicSmokeClassification[] = [
    'dns_not_pointing',
    'tls_not_ready',
    'unreachable',
];

/** The one classification that is health-relevant (FR-37, §5.6 step 9). */
export const APP_PUBLIC_SMOKE_HEALTH_CODE = 'check_failed' as const;

/** §4.8's `DEFAULT_STATUS` (`app-runner.script.ts:191`), restated for the public half. */
export const APP_SMOKE_DEFAULT_STATUS: readonly number[] = [200, 201, 204];

/** §4.8's `DEFAULT_LATENCY_MS` (`app-runner.script.ts:192`). */
export const APP_SMOKE_DEFAULT_LATENCY_MS = 10_000;

/**
 * How long an excerpt may carry of the text **before** the string it quotes, mirroring the
 * runner's `CONTEXT_CHARS` (`app-runner.script.ts:189`) so the two halves quote comparably.
 */
export const APP_SMOKE_FOUND_CONTEXT_CHARS = 40;

/** What replaces a secret value inside an excerpt — §4.8's `REDACTED` (`app-runner.script.ts:190`). */
export const APP_SMOKE_REDACTED = '***';

/**
 * The attempt cap that makes the window loop provably finite: 600 s ÷ 10 s + 1. Even a caller whose
 * clock never advances cannot spin here — the loop stops on the cap and reports what it observed
 * (the last attempt's results), never an exception.
 */
export const APP_PUBLIC_SMOKE_MAX_ATTEMPTS =
    Math.ceil(APP_SMOKE_PUBLIC_FIRST_WINDOW_S / APP_SMOKE_RETRY_S) + 1;

/** The one classification code a transport failure maps to when nothing more specific is known. */
export const APP_PUBLIC_SMOKE_UNREACHABLE_MESSAGE =
    'The public address did not answer, so the check could not run.';

/* -------------------------------------------------------------------------- *
 * Request and result
 * -------------------------------------------------------------------------- */

/** What the caller knows when it asks for the public half of the smoke run. */
export interface AppPublicSmokeRequest {
    /** App Work id. Never sent anywhere and never printed — it only scopes the log lines. */
    workId: string;
    /**
     * The published public URLs, **primary first** — `hooks.verifyPublic`'s own `urls`
     * (`app-deployment.types.ts:410`), built by the plugin from §4.11's published hosts
     * (`app-deployer.ts:1604-1607`). Only the first entry is smoke-tested: they are the same app,
     * and FR-36 names "the public address" (singular).
     */
    urls: readonly string[];
    /** The App spec's smoke checks, for the checks that apply to this Deployment. */
    checks: readonly AppSmokeInput[];
    /**
     * `hooks.verifyPublic`'s window: 600 s on the first publish, 180 s afterwards. Absent ⇒
     * {@link publicSmokeWindowSeconds} answers from `isFirstDeploymentOnCluster`.
     */
    windowSeconds?: number;
    /** FR-36: a `first-deploy` check runs on the first Deployment only. */
    isFirstDeploymentOnCluster?: boolean;
    /**
     * The address §4.11's ingress reported, **already resolved**: `ingressAddress.ip`, plus the
     * addresses of `ingressAddress.hostname` when it was a hostname. Empty ⇒ no DNS judgement is
     * made (there is nothing to compare against), never "assume it points here".
     */
    ingressAddresses?: readonly string[];
    /** The same checks' in-cluster results from §5.6's phase 5, for FR-37's "while in-cluster passed". */
    inCluster?: readonly CheckResult[];
    /** Values that must never appear in an excerpt (Constitution VII); matched literally, scrubbed. */
    secretValues?: readonly string[];
    /** A caller-owned abort — the `app-deploy` job's deadline, or the caller's own cancel check. */
    signal?: AbortSignal;
}

/** One classified failure, for the Deployment's `appRender.warnings` and the `app.smoke.*` event. */
export interface AppPublicSmokeFinding {
    code: AppPublicSmokeClassification;
    /** The check's own name, so a reader can find it in the App spec. */
    check: string;
    message: string;
    /** §4.8's `failedExpectation`, when there was one. */
    failedExpectation?: string;
    /** §4.8's `found` — ≤ 200 characters, secret-scrubbed (FR-37). */
    found?: string;
}

/** A `check_failed` finding, which is the only health-relevant one (FR-37). */
export interface AppPublicSmokeFailure extends AppPublicSmokeFinding {
    code: 'check_failed';
    /**
     * `true` ⇔ this failure counts toward health: the check **failed publicly** and its in-cluster
     * peer did not fail (FR-37: "only check failed while in-cluster passed counts toward health").
     * With no in-cluster evidence the answer is `true`, because an unnoticed broken app is the
     * worse error.
     */
    healthRelevant: boolean;
}

/** The DNS verdict of one attempt — reported so S19 can name the record to create. */
export interface AppPublicSmokeDnsVerdict {
    host: string;
    /** What the host resolved to (empty ⇒ it did not resolve at all). */
    addresses: string[];
    /** What the ingress reported (§4.11). */
    expected: string[];
    /** `null` when no expectation was supplied, so nothing was judged. */
    pointing: boolean | null;
}

/**
 * What {@link AppPublicSmokeService.run} resolves to.
 *
 * `checks` and `passed` are the `AppSmokeRun` the plugin consumes; everything else is this epic's
 * own reporting, so §5.6 can tell a warning from a health-relevant failure without re-deriving it
 * from `classification`.
 */
export interface AppPublicSmokeRun extends AppSmokeRun {
    /**
     * `passed` when every check passed, `warnings` when none was `check_failed` but something else
     * failed, `failed` when at least one check was `check_failed`. Never a rollback on any of them
     * (FR-26 step 7).
     */
    outcome: 'passed' | 'warnings' | 'failed';
    /** The classified non-`check_failed` failures — §5.6 step 9's "warnings". */
    warnings: AppPublicSmokeFinding[];
    /** The `check_failed` failures — the only ones `app.smoke.failed` counts (§5.6 step 9). */
    failures: AppPublicSmokeFailure[];
    /** `true` ⇔ at least one health-relevant failure (FR-47, `app-health-poll`'s verdict input). */
    healthRelevant: boolean;
    /** The window actually used: 600 s on the first publish, 180 s afterwards. */
    windowSeconds: number;
    /** How many times the check set was attempted (1 ⇔ it passed first time). */
    attempts: number;
    /**
     * The first attempt's DNS verdict. `null` only when the run never reached an attempt;
     * an empty expectation list is a `pointing: false` REFUSAL, not a skipped gate — see
     * {@link AppPublicSmokeService.dnsVerdict}.
     */
    dns: AppPublicSmokeDnsVerdict | null;
    /** ISO — the moment the run ended, which is what `appRender.smokeResult.observedAt` records. */
    observedAt: string;
}

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/**
 * The platform's public smoke runner (T23). Stateless and safe to construct anywhere: it holds no
 * client, no credential and no cache, so the API process may construct it without acquiring a
 * cluster route (FR-5) — and §5.6's worker is the only caller that dials anything with it.
 */
@Injectable()
export class AppPublicSmokeService {
    private readonly logger = new Logger(AppPublicSmokeService.name);

    /**
     * The one place the outbound HTTP call is made (provisional seam, header). A worker that
     * ships its own dispatcher (a proxy, a custom agent) overrides this instead of the service.
     *
     * **It is `safeFetchWithDnsPin`, not the bare global `fetch`.** This service runs in a
     * cluster-privileged worker and dials a URL derived from a Work's own custom domain — an
     * address the *member* controls. The bare global was an unguarded SSRF: a member could point
     * a smoke check at `169.254.169.254`, a `10.x` service, or a hostname that answers public at
     * validation time and private at fetch time, and the worker would dial it and hand back
     * status, latency and up to {@link APP_SMOKE_BODY_BYTES} of the body. `safeFetchWithDnsPin`
     * is the guard the repository already ships
     * (`packages/plugin/src/helpers/ssrf-guard.ts:206`): lexical check, then resolve, then refuse
     * if **any** resolved address is private/loopback/link-local (not “pick the public one”),
     * then dial — the same re-resolve window this branch's own `app-kubeconfig.guard.ts` was
     * written to close.
     *
     * An `SsrfBlockedError` from it lands in {@link runCheck}'s existing catch and is classified
     * like any other transport failure, so a refused check is a *failed check* with a reason, not
     * a crashed run.
     */
    protected fetchImpl: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) =>
        safeFetchWithDnsPin(String(input), init);

    /**
     * Run the App spec's smoke checks over the public address, retrying every
     * {@link APP_SMOKE_RETRY_S} until they all pass or the window runs out.
     *
     * Resolves — always. A transport failure, a DNS mismatch, an unparseable URL and a caller
     * abort are all *results* here, because every one of them is a warning the Deploy tab renders
     * (S19) rather than a reason to fail the Deployment:
     *
     * ```ts
     * async verifyPublic(req: { urls; checks; windowSeconds }): Promise<AppSmokeRun> {
     *     return this.smoke.run({ ...req, workId });      // §5.6 step 4 — T25
     * }
     * ```
     */
    async run(request: AppPublicSmokeRequest): Promise<AppPublicSmokeRun> {
        const windowSeconds = this.windowSecondsFor(request);
        const windowMs = Math.max(0, windowSeconds * 1_000);
        const retryMs = APP_SMOKE_RETRY_S * 1_000;
        const secrets = (request?.secretValues ?? []).map(String).filter((v) => v.length > 0);

        const checks = smokeChecksFor(request?.isFirstDeploymentOnCluster, request?.checks ?? []);
        const base = firstUrl(request?.urls);
        const startedAt = this.now();

        // Nothing to smoke: no host was published, or the spec declares no check that applies to
        // this Deployment. §5.5's plugin returns before calling at all (`app-deployer.ts:1612-1614`);
        // a caller that calls anyway gets an empty, passing run rather than a fabricated failure.
        if (!base || checks.length === 0) {
            return {
                checks: [],
                passed: true,
                outcome: 'passed',
                warnings: [],
                failures: [],
                healthRelevant: false,
                windowSeconds,
                attempts: 0,
                dns: null,
                observedAt: new Date(this.now()).toISOString(),
            };
        }

        let attempt = 0;
        let results: CheckResult[] = [];
        let dns: AppPublicSmokeDnsVerdict | null = null;

        while (attempt < APP_PUBLIC_SMOKE_MAX_ATTEMPTS) {
            // The window governs attempts, so an attempt that has no room is never started (and a
            // check that never ran is never reported as failed).
            if (windowMs - (this.now() - startedAt) <= 0) break;

            attempt += 1;

            const attemptResult = await this.attempt(base, checks, request, secrets);
            results = attemptResult.checks;
            dns = attemptResult.dns;

            if (attemptResult.allPassed) break;

            // Another attempt only if it fits inside the window: a retry that would end after the
            // window is a retry the FR-26 step 7 window never granted.
            if (this.now() - startedAt + retryMs >= windowMs) break;

            await this.sleep(retryMs);
        }

        return this.finish(results, dns, windowSeconds, attempt, request?.inCluster ?? []);
    }

    /* ---------------------------------------------------------------------- *
     * One attempt
     * ---------------------------------------------------------------------- */

    /**
     * One pass over the check set: the DNS verdict first, then each check in the spec's own order.
     *
     * The DNS verdict gates the whole set on purpose. §5.5's classification order is
     * DNS → TLS → connect → expectation, and a host that does not point at the cluster answers the
     * later three for a reason that is not the app's: every check would report `tls_not_ready` or
     * `unreachable` and S19 would show a TLS problem where the real message is "create this DNS
     * record".
     */
    private async attempt(
        base: URL,
        checks: readonly AppSmokeInput[],
        request: AppPublicSmokeRequest,
        secrets: readonly string[],
    ): Promise<{
        checks: CheckResult[];
        dns: AppPublicSmokeDnsVerdict | null;
        allPassed: boolean;
    }> {
        const dns = await this.dnsVerdict(base, request?.ingressAddresses ?? []);

        if (dns && dns.pointing === false) {
            const expected = dns.expected.join(', ');
            const addresses = dns.addresses.length > 0 ? dns.addresses.join(', ') : 'nothing';

            // Two different refusals share this branch, and they must not share a message: an
            // empty `expected` means the CALLER gave us no ingress address, which is our
            // problem to report, not a DNS record the owner has to create.
            const failedExpectation =
                dns.expected.length === 0
                    ? `no ingress address was supplied for ${dns.host}, so the DNS check (§5.5's first ` +
                      'classification step) cannot run and the public checks are refused rather than ' +
                      'dialled unverified. Supply `ingressAddresses` once the Deployment has one.'
                    : `${dns.host} must resolve to the cluster's ingress address (${expected}) ` +
                      `but resolved to ${addresses}`;

            const checksWithDns: CheckResult[] = checks.map((check) => ({
                name: checkName(check),
                status: 'failed',
                classification: 'dns_not_pointing',
                failedExpectation,
            }));

            return { checks: checksWithDns, dns, allPassed: false };
        }

        const results: CheckResult[] = [];
        for (const check of checks) {
            if (request?.signal?.aborted === true) break;
            results.push(await this.runCheck(base, check, secrets, request?.signal));
        }

        return {
            checks: results,
            dns,
            allPassed: results.length === checks.length && results.every(isPassed),
        };
    }

    /** §5.5's DNS rule: "DNS lookup of the host ≠ ingress address → `dns_not_pointing`". */
    private async dnsVerdict(
        base: URL,
        ingressAddresses: readonly string[],
    ): Promise<AppPublicSmokeDnsVerdict | null> {
        const expected = (ingressAddresses ?? [])
            .map((value) => String(value).trim())
            .filter(Boolean);
        // An empty expectation list is a REFUSAL, not a skipped gate.
        //
        // It used to answer `null`, and `attempt()` only acts on `pointing === false` — so an
        // empty list turned the DNS gate off entirely and the worker dialled whatever the host
        // resolved to. Empty is also the *default*: `ingressAddresses` is an optional request
        // field and `app-health.service.ts:1232` supplies `resolvedAddresses(ingressAddress)`,
        // which is `[]` whenever the ingress address is not yet known. So the one configuration
        // that disabled the check was the one every un-provisioned Work was in.
        //
        // `pointing: false` with an empty `expected` is the honest verdict: we were given
        // nothing to compare against, so we cannot say this host points at the cluster, and
        // §5.5's classification order (DNS first) means we must not dial before we can.
        // {@link attempt}'s existing branch turns it into `dns_not_pointing` on every check,
        // and the message names the missing input rather than blaming the app.
        if (expected.length === 0) {
            return {
                host: base.hostname,
                addresses: [],
                expected: [],
                pointing: false,
            };
        }

        const host = base.hostname;
        const addresses = isIP(host) > 0 ? [host] : await this.resolveHostAddresses(host);

        return {
            host,
            addresses,
            expected,
            pointing: addresses.some((address) => expected.includes(address)),
        };
    }

    /**
     * One check, over the public address: request, capped read, judgement — and, on any throw, the
     * §5.5 classification. Never throws.
     */
    private async runCheck(
        base: URL,
        check: AppSmokeInput,
        secrets: readonly string[],
        signal?: AbortSignal,
    ): Promise<CheckResult> {
        const name = checkName(check);
        const expect = expectationsOf(check);
        const url = this.checkUrl(base, check);
        const startedAt = this.now();

        // The check's own latency limit, never the window: FR-36 makes "the response arrives within
        // its latency limit" part of the check, so exceeding it fails the check — while §5.5's
        // `unreachable` is what a *connect* timeout is. The window governs attempts only.
        const timeoutMs = Math.max(1, expect.maxLatencyMs);

        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const abort = (): void => controller.abort();
        if (signal) signal.addEventListener?.('abort', abort, { once: true });

        try {
            const response = await this.fetchImpl(url, {
                method: expect.method,
                // FR-36: "Smoke, job and scheduled requests never follow redirects: a redirect is
                // judged by its own status."
                redirect: 'manual',
                headers: expect.headers,
                ...(expect.body === undefined ? {} : { body: expect.body }),
                signal: controller.signal,
            });

            const latencyMs = this.now() - startedAt;
            const read = await readCapped(response, APP_SMOKE_BODY_BYTES);

            return judge(name, response.status, read.text, latencyMs, expect, secrets);
        } catch (error) {
            const latencyMs = this.now() - startedAt;

            if (timedOut) {
                // FR-36's own pass condition: "the response arrives within its latency limit". The
                // app answered too slowly, which is a failed check — not §5.5's `unreachable`, which
                // is a *connect* that never completed.
                return {
                    name,
                    status: 'failed',
                    latencyMs,
                    classification: 'check_failed',
                    failedExpectation: `latency must be at most ${expect.maxLatencyMs} ms but the request did not answer within ${timeoutMs} ms`,
                };
            }

            return {
                name,
                status: 'failed',
                latencyMs,
                classification: classifyPublicSmokeError(error),
                failedExpectation: signal?.aborted
                    ? 'the public smoke run was aborted before this check answered'
                    : `request failed: ${scrubSecrets(messageOf(error), secrets)}`,
                ...foundOf(excerpt(messageOf(error), null, secrets)),
            };
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener?.('abort', abort);
        }
    }

    /* ---------------------------------------------------------------------- *
     * Result assembly
     * ---------------------------------------------------------------------- */

    /** Split the observed checks into §5.6 step 9's two channels and answer the summaries. */
    private finish(
        checks: readonly CheckResult[],
        dns: AppPublicSmokeDnsVerdict | null,
        windowSeconds: number,
        attempts: number,
        inCluster: readonly CheckResult[],
    ): AppPublicSmokeRun {
        const warnings: AppPublicSmokeFinding[] = [];
        const failures: AppPublicSmokeFailure[] = [];
        const inClusterByName = new Map<string, CheckResult>();
        for (const check of inCluster ?? []) {
            if (check?.name) inClusterByName.set(String(check.name), check);
        }

        for (const check of checks) {
            if (isPassed(check)) continue;

            const classification = classificationOf(check);

            if (classification === APP_PUBLIC_SMOKE_HEALTH_CODE) {
                const peer = inClusterByName.get(String(check.name));
                failures.push({
                    code: 'check_failed',
                    check: check.name,
                    message:
                        check.failedExpectation ?? `Public smoke check '${check.name}' failed.`,
                    ...(check.failedExpectation
                        ? { failedExpectation: check.failedExpectation }
                        : {}),
                    ...(check.found ? { found: check.found } : {}),
                    // FR-37: "only check failed while in-cluster passed counts toward health". A
                    // peer that already failed in-cluster is the in-cluster half's business (it
                    // rolled the Deployment back); with no peer at all the answer is `true`, because
                    // an unnoticed broken app is the worse error.
                    healthRelevant: peer ? peer.status !== 'failed' : true,
                });
                continue;
            }

            warnings.push({
                code: classification,
                check: check.name,
                message:
                    check.failedExpectation ??
                    `${classification.replace(/_/g, ' ')} while checking '${check.name}'.`,
                ...(check.failedExpectation ? { failedExpectation: check.failedExpectation } : {}),
                ...(check.found ? { found: check.found } : {}),
            });
        }

        const outcome =
            failures.length > 0 ? 'failed' : warnings.length > 0 ? 'warnings' : 'passed';

        return {
            checks,
            passed: checks.length > 0 && checks.every(isPassed),
            outcome,
            warnings,
            failures,
            healthRelevant: failures.some((failure) => failure.healthRelevant),
            windowSeconds,
            attempts,
            dns,
            observedAt: new Date(this.now()).toISOString(),
        };
    }

    /* ---------------------------------------------------------------------- *
     * Seams and pure-ish helpers
     * ---------------------------------------------------------------------- */

    /** The window the caller asked for, else FR-26 step 7's pair. */
    protected windowSecondsFor(request: AppPublicSmokeRequest): number {
        const declared = Number(request?.windowSeconds);
        if (Number.isFinite(declared) && declared > 0) return Math.floor(declared);

        return publicSmokeWindowSeconds(request?.isFirstDeploymentOnCluster === true);
    }

    /** `base` + the check's own path, resolved against the published address (never a redirect). */
    protected checkUrl(base: URL, check: AppSmokeInput): string {
        const path = String(check?.http?.path ?? '/').trim() || '/';
        return new URL(path.startsWith('/') ? path : `/${path}`, base).toString();
    }

    /** The clock seam (header). */
    protected now(): number {
        return Date.now();
    }

    /** The retry seam (header). */
    protected async sleep(ms: number): Promise<void> {
        await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
    }

    /**
     * The DNS seam (header). Never throws: a host that does not resolve is `dns_not_pointing`
     * evidence, not an exception — and `ENOTFOUND` is exactly what "the record is not there yet"
     * looks like (S19).
     */
    protected async resolveHostAddresses(host: string): Promise<string[]> {
        return await new Promise<string[]>((resolve) => {
            dns.lookup(
                host,
                { all: true },
                (error: NodeJS.ErrnoException | null, records: unknown) => {
                    if (error) {
                        this.logger.debug(
                            `Resolving ${host} for the public smoke check failed (${String(
                                error.code ?? error.message,
                            )}).`,
                        );
                        resolve([]);
                        return;
                    }

                    const list = Array.isArray(records) ? records : [records];
                    resolve(
                        list
                            .map((record) =>
                                typeof record === 'string'
                                    ? record
                                    : String((record as { address?: unknown })?.address ?? ''),
                            )
                            .filter((address) => address.length > 0),
                    );
                },
            );
        });
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers — everything worth testing without a socket
 * -------------------------------------------------------------------------- */

/** FR-26 step 7: 600 s on the first publish, 180 s on every later one. */
export function publicSmokeWindowSeconds(isFirstPublish: boolean): number {
    return isFirstPublish ? APP_SMOKE_PUBLIC_FIRST_WINDOW_S : APP_SMOKE_PUBLIC_WINDOW_S;
}

/**
 * FR-36's "checks marked first-deploy run only on the first Deployment".
 *
 * The same filter the k8s renderer applies to the in-cluster set
 * (`app-jobs.renderer.ts:815-818`, `smokeChecksFor`) — spelled here because the agent may not
 * import that package (header), and pinned on both sides by test.
 */
export function smokeChecksFor(
    isFirstDeploymentOnCluster: boolean | undefined,
    checks: readonly AppSmokeInput[],
): AppSmokeInput[] {
    return (checks ?? []).filter(
        (check) => check?.when !== 'first-deploy' || isFirstDeploymentOnCluster === true,
    );
}

/** The first usable published URL, or `null` when the caller published none. */
export function firstUrl(urls: readonly string[] | undefined): URL | null {
    for (const value of urls ?? []) {
        const raw = String(value ?? '').trim();
        if (raw.length === 0) continue;

        try {
            const url = new URL(raw);
            if (url.hostname.length > 0) return url;
        } catch {
            // A caller's malformed URL is not a smoke failure — there is simply no address.
            continue;
        }
    }

    return null;
}

/** A check's name, never empty (the renderer resolves it; a hand-built input may not). */
export function checkName(check: AppSmokeInput | null | undefined): string {
    const name = String(check?.name ?? '').trim();
    return name.length > 0 ? name : 'check';
}

/** One check's resolved expectations, with §4.8's three defaults. */
export function expectationsOf(check: AppSmokeInput): {
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
    status: number[];
    bodyContains: string[];
    bodyNotContains: string[];
    maxLatencyMs: number;
} {
    const declared = check?.expect ?? {};
    const method = String(check?.http?.method ?? 'GET')
        .trim()
        .toUpperCase();
    const body = check?.http?.body === undefined ? undefined : JSON.stringify(check.http.body);

    return {
        method: method.length > 0 ? method : 'GET',
        headers:
            body === undefined
                ? { accept: '*/*' }
                : { accept: '*/*', 'content-type': 'application/json' },
        body,
        status:
            Array.isArray(declared.status) && declared.status.length > 0
                ? declared.status.map(Number)
                : [...APP_SMOKE_DEFAULT_STATUS],
        bodyContains: (declared.bodyContains ?? []).map(String),
        bodyNotContains: (declared.bodyNotContains ?? []).map(String),
        maxLatencyMs:
            Number(declared.maxLatencyMs) > 0
                ? Number(declared.maxLatencyMs)
                : APP_SMOKE_DEFAULT_LATENCY_MS,
    };
}

/**
 * §4.8's `judge`, over the public half: status, then latency, then `bodyContains`, then
 * `bodyNotContains` — the runner's own order (`app-runner.script.ts:337-369`), so the two halves
 * quote the same expectation for the same body.
 */
export function judge(
    name: string,
    status: number,
    text: string,
    latencyMs: number,
    expect: ReturnType<typeof expectationsOf>,
    secrets: readonly string[] = [],
): CheckResult {
    if (expect.status.length > 0 && !expect.status.includes(status)) {
        return {
            name,
            status: 'failed',
            httpStatus: status,
            latencyMs,
            classification: 'check_failed',
            failedExpectation: `status is one of ${expect.status.join(', ')} but was ${status}`,
            ...foundOf(excerpt(text, null, secrets)),
        };
    }

    if (latencyMs > expect.maxLatencyMs) {
        return {
            name,
            status: 'failed',
            httpStatus: status,
            latencyMs,
            classification: 'check_failed',
            failedExpectation: `latency must be at most ${expect.maxLatencyMs} ms but was ${latencyMs} ms`,
        };
    }

    for (const needle of expect.bodyContains) {
        if (text.includes(needle)) continue;
        return {
            name,
            status: 'failed',
            httpStatus: status,
            latencyMs,
            classification: 'check_failed',
            failedExpectation: `body must contain ${JSON.stringify(needle)}`,
            ...foundOf(excerpt(text, null, secrets)),
        };
    }

    for (const needle of expect.bodyNotContains) {
        const at = text.indexOf(needle);
        if (at < 0) continue;
        return {
            name,
            status: 'failed',
            httpStatus: status,
            latencyMs,
            classification: 'check_failed',
            failedExpectation: `body must not contain ${JSON.stringify(needle)}`,
            ...foundOf(excerpt(text, at, secrets)),
        };
    }

    return { name, status: 'passed', httpStatus: status, latencyMs };
}

/**
 * §5.5's classifier: TLS handshake/name failure → `tls_not_ready`; a missing record →
 * `dns_not_pointing`; anything else that stopped the request → `unreachable`.
 *
 * Walks the `cause` chain because that is where undici puts the real code — `fetch` rejects with
 * `TypeError: fetch failed` and the certificate error is `error.cause`
 * (`webhook-delivery.service.ts:129-137` reads the same shape for its own classification).
 */
export function classifyPublicSmokeError(error: unknown): AppPublicSmokeClassification {
    const codes = errorCodes(error);

    if (codes.some(isMissingRecordCode)) return 'dns_not_pointing';
    if (codes.some(isTlsCode)) return 'tls_not_ready';
    return 'unreachable';
}

/** Every `code` in an error's `cause` chain, lower-cased for comparison. */
export function errorCodes(error: unknown): string[] {
    const codes: string[] = [];
    let current: unknown = error;

    for (let depth = 0; depth < 8 && current; depth += 1) {
        const code = (current as { code?: unknown }).code;
        if (typeof code === 'string' && code.length > 0) codes.push(code.toLowerCase());
        current = (current as { cause?: unknown }).cause;
    }

    return codes;
}

/** The codes that mean "the name does not resolve" — §5.5's first classification. */
function isMissingRecordCode(code: string): boolean {
    return [
        'enotfound',
        'eainoname',
        'eai_noname',
        'eainodata',
        'eai_nodata',
        'nxdomain',
        'err_socket_dns',
    ].includes(code);
}

/** The codes that mean "the TLS handshake did not complete" — §5.5's second classification. */
function isTlsCode(code: string): boolean {
    if (code.startsWith('err_tls')) return true;
    if (code.startsWith('err_ssl')) return true;
    if (code.startsWith('cert_')) return true;

    return [
        'depth_zero_self_signed_cert',
        'self_signed_cert_in_chain',
        'unable_to_verify_leaf_signature',
        'unable_to_get_issuer_cert_locally',
        'unable_to_get_issuer_cert',
        'hostname_mismatch',
        'eproto',
    ].includes(code);
}

/**
 * The scrub FR-37 requires ("never a secret value"). Literal replacement, longest value first so a
 * secret that contains another secret still scrubs whole.
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
    let value = String(text ?? '');
    const ordered = [...(secrets ?? [])]
        .map(String)
        .filter((secret) => secret.length > 0)
        .sort((a, b) => b.length - a.length);

    for (const secret of ordered) {
        value = value.split(secret).join(APP_SMOKE_REDACTED);
    }

    return value;
}

/**
 * §4.8's `trimFound`: an excerpt around the offending string, at most
 * {@link APP_SMOKE_FOUND_CHARS} characters, secret-scrubbed — the only text that may leave this
 * service (FR-37, `spec.md:422`).
 *
 * `at` is the index the failing `bodyNotContains` string was found at, or `null` for a
 * whole-body failure, in which case the excerpt starts at the body's beginning.
 */
export function excerpt(
    text: string,
    at: number | null = null,
    secrets: readonly string[] = [],
): string {
    const scrubbed = scrubSecrets(String(text ?? ''), secrets);
    const from = at === null || at < 0 ? 0 : Math.max(0, at - APP_SMOKE_FOUND_CONTEXT_CHARS);

    // Both ellipses live inside the 200-character cap, so the excerpt can never be one character
    // longer than FR-37 allows just because it was trimmed at both ends.
    const head = from > 0 ? '…' : '';
    const tail = from + APP_SMOKE_FOUND_CHARS < scrubbed.length ? '…' : '';
    const room = Math.max(0, APP_SMOKE_FOUND_CHARS - head.length - tail.length);

    return `${head}${scrubbed.slice(from, from + room)}${tail}`;
}

/** A `found` block only when there is something to quote — an empty body adds nothing. */
function foundOf(found: string): { found?: string } {
    return found.length > 0 ? { found: found.slice(0, APP_SMOKE_FOUND_CHARS) } : {};
}

/** The classification of a failed check; a producer that set none failed the expectation. */
export function classificationOf(check: CheckResult): AppPublicSmokeClassification {
    const classification = check?.classification;
    return classification ? classification : APP_PUBLIC_SMOKE_HEALTH_CODE;
}

/** `true` ⇔ the check passed (a skipped check is not a pass, and is not a failure either). */
function isPassed(check: CheckResult): boolean {
    return check?.status === 'passed';
}

/** A one-line reason for a thrown check, never a stack and never a body. */
function messageOf(error: unknown): string {
    if (error instanceof Error && typeof error.message === 'string') return error.message;
    if (typeof error === 'string') return error;

    const message = (error as { message?: unknown })?.message;
    return typeof message === 'string' ? message : 'unknown error';
}

/**
 * §4.8's `readCapped`, over a `Response`: read at most `maxBytes` and **cancel** the rest, so the
 * body a caller never sees is never held in memory either.
 */
export async function readCapped(
    response: Response,
    maxBytes: number = APP_SMOKE_BODY_BYTES,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
    const body = response?.body;

    if (!body || typeof body.getReader !== 'function') {
        const text = typeof response?.text === 'function' ? await response.text() : '';
        const value = typeof text === 'string' ? text : '';
        return { text: value, bytes: value.length, truncated: false };
    }

    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let bytes = 0;
    let truncated = false;
    let text = '';

    for (;;) {
        const step = await reader.read();
        if (step.done) {
            text += decoder.decode();
            break;
        }

        const chunk = step.value as Uint8Array;
        if (bytes + chunk.length > maxBytes) {
            text += decoder.decode(chunk.subarray(0, Math.max(0, maxBytes - bytes)));
            bytes = maxBytes;
            truncated = true;
            await reader.cancel().catch(() => undefined);
            break;
        }

        bytes += chunk.length;
        text += decoder.decode(chunk, { stream: true });
    }

    return { text, bytes, truncated };
}
