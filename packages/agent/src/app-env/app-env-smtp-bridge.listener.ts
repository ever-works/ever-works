/**
 * Lane aw-env-smtp (2026-10-18, GAP-22) — `AppEnvSmtpBridgeListener`: an owner's own SMTP server,
 * set through the App env, satisfies the `smtp` dependency without provisioning anything.
 *
 * ## The problem it closes
 *
 * An App spec that declares `smtp` binds its mail settings to the dependency's outputs:
 *
 * ```yaml
 * - { name: SMTP_HOST, from: deps.smtp.host }
 * - { name: SMTP_PASSWORD, secret: true, from: deps.smtp.password }
 * ```
 *
 * An owner who types their own server into those names (`PUT /api/works/:id/app-env`) already gets
 * those values in the app — a stored row wins over every source (`app-env.resolver.ts`, §2.2:117). But
 * the Deploy would still be refused `dependency_not_ready: smtp` while the dependency row waits for a
 * provider, and the in-namespace mail sink would be provisioned for nothing.
 *
 * ## What it does
 *
 * On `app.env.changed`, when the change touches a name bound to `deps.smtp.<output>`, it reads the
 * stored values of every such name and hands them to `AppDependenciesService.configure(workId,
 * 'smtp', { config })` — the dependency's "external SMTP" configuration, encrypted before it is
 * stored. The `k8s-inline-mailpit` provider then answers that configuration as the outputs with no
 * cluster object created (`smtp.provider.ts`, "Bring your own"), and the row reads `ready`.
 *
 * - The configuration carries `host` only when the owner set one: removing the `SMTP_HOST` value sends
 *   an EMPTY configuration, and the row goes back to the mail sink.
 * - A change that touches no `deps.smtp.*`-bound name does nothing at all (no re-dispatch).
 * - Values are never logged; a failure is logged by name only, and never fails the env write that
 *   emitted the event (the listener is a reaction, not a precondition).
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { appEnvDependencyRefOf } from '@ever-works/contracts';

import { AppDependenciesService } from '../app-dependencies/app-dependencies.service';
import { AppEnvChangedEvent } from '../events/app-env.events';
import { AppEnvResolver } from './app-env.resolver';
import { APP_ENV_SPEC_SOURCE, type AppEnvSpecSource } from './app-env.service';

/** The `smtp` outputs a bring-your-own configuration may carry (`APP_DEPENDENCY_OUTPUTS.smtp`). */
export const APP_ENV_SMTP_BRIDGE_OUTPUTS = [
    'host',
    'port',
    'user',
    'password',
    'from',
    'secure',
] as const;

@Injectable()
export class AppEnvSmtpBridgeListener {
    private readonly logger = new Logger(AppEnvSmtpBridgeListener.name);

    constructor(
        @Optional() private readonly dependencies?: AppDependenciesService,
        @Optional() private readonly resolver?: AppEnvResolver,
        @Optional()
        @Inject(APP_ENV_SPEC_SOURCE)
        private readonly spec?: AppEnvSpecSource,
    ) {}

    @OnEvent(AppEnvChangedEvent.EVENT_NAME, { async: true })
    async onEnvChanged(event: AppEnvChangedEvent): Promise<void> {
        const workId = event?.payload?.workId;
        if (!workId) return;
        try {
            await this.bridge(workId, event.payload.names ?? []);
        } catch (error) {
            this.logger.warn(
                `App env → smtp dependency bridge failed for work ${workId} (${error instanceof Error ? error.name : 'error'}).`,
            );
        }
    }

    /**
     * Mirror the owner's `deps.smtp.*`-bound values into the `smtp` dependency's configuration.
     * Answers whether `configure` was called.
     */
    async bridge(workId: string, changed: readonly string[]): Promise<boolean> {
        if (!this.dependencies || !this.resolver || !this.spec) return false;

        const snapshot = await this.spec.read(workId);
        const spec = snapshot?.spec;
        if (!spec?.dependencies?.smtp) return false;

        const bound = smtpBoundNames(spec.env ?? []);
        const names = Object.values(bound);
        if (names.length === 0 || !changed.some((name) => names.includes(name))) return false;

        const stored = await this.resolver.readStoredValuesOf(workId, names);
        const config: Record<string, string> = {};
        for (const [output, name] of Object.entries(bound)) {
            const value = stored[name];
            if (typeof value === 'string' && value.length > 0) config[output] = value;
        }

        // No host of the owner's own: the sink serves the dependency again.
        await this.dependencies.configure(workId, 'smtp', { config: config.host ? config : {} });
        return true;
    }
}

/**
 * `output → env name` for every entry bound to `from: deps.smtp.<output>` — the first entry of an
 * output wins (two names reading one output carry the same value).
 */
export function smtpBoundNames(
    env: readonly { name?: string; from?: string }[],
): Partial<Record<(typeof APP_ENV_SMTP_BRIDGE_OUTPUTS)[number], string>> {
    const bound: Partial<Record<(typeof APP_ENV_SMTP_BRIDGE_OUTPUTS)[number], string>> = {};
    for (const entry of env) {
        if (typeof entry?.name !== 'string' || typeof entry.from !== 'string') continue;
        const ref = appEnvDependencyRefOf(entry.from);
        if (!ref || ref.kind !== 'smtp') continue;
        const output = ref.output as (typeof APP_ENV_SMTP_BRIDGE_OUTPUTS)[number];
        if (!(APP_ENV_SMTP_BRIDGE_OUTPUTS as readonly string[]).includes(output)) continue;
        if (!bound[output]) bound[output] = entry.name;
    }
    return bound;
}
