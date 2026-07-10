import type { JobEnqueueOptions } from '@ever-works/plugin';
import type {
	InngestClient,
	InngestDispatcherFactoryOptions,
	InngestFunction,
	InngestSendEvent
} from './inngest-types.js';
import { mapEnqueueOptions } from './inngest-enqueue-options.js';

/**
 * EW-742 P3.2 follow-up — operator-facing factory that wraps an
 * Inngest client and exposes per-event dispatcher functions.
 *
 * # Usage (operator-side serverless app)
 *
 * ```ts
 * import { Inngest } from 'inngest';
 * import { serve } from 'inngest/next';
 * import {
 *   InngestJobRuntimePlugin,
 *   InngestDispatcherFactory
 * } from '@ever-works/job-runtime-inngest-plugin';
 *
 * const client = new Inngest({ id: 'ever-works', eventKey: process.env.INNGEST_EVENT_KEY });
 * const factory = new InngestDispatcherFactory({ client, eventNamespace: 'ever.works' });
 *
 * const kbEmbedFn = factory.defineFunction(
 *   { id: 'kb-embed-document' },
 *   { event: 'ever.works/kb-embed-document' },
 *   async ({ event }) => { ... }
 * );
 *
 * const plugin = new InngestJobRuntimePlugin()
 *   .useDispatchers({
 *     dispatchKbEmbedDocument: (payload) => factory.send('kb-embed-document', payload)
 *   })
 *   .useDispatcherFactory(factory);
 *
 * // Mount the Inngest serve handler at /api/inngest:
 * export default serve({ client, functions: factory.functions });
 * ```
 *
 * # Per-tenant routing (SaaS only)
 *
 * For SaaS BYO, build one `Inngest` client per tenant (per the
 * snapshot's eventKey/signingKey) and one factory per client; pass the
 * per-tenant factory through
 * `InngestJobRuntimePluginOptions.dispatchersBuilder` so
 * `bindToTenant(snapshot)` views route to the right Inngest project.
 */
export class InngestDispatcherFactory {
	private readonly registeredFunctions: InngestFunction[] = [];

	constructor(private readonly opts: InngestDispatcherFactoryOptions) {}

	get client(): InngestClient {
		return this.opts.client;
	}

	/**
	 * Send one event. Returns the Inngest-assigned id (always the
	 * first element of `result.ids` — single-event sends always come
	 * back with one id). Returns `null` if Inngest's response is
	 * shaped unexpectedly.
	 */
	async send(
		eventName: string,
		data: unknown,
		overrides?: Partial<Omit<InngestSendEvent, 'name' | 'data'>>
	): Promise<string | null> {
		const fullName = this.opts.eventNamespace ? `${this.opts.eventNamespace}/${eventName}` : eventName;
		const event: InngestSendEvent = {
			name: fullName,
			data,
			...(overrides ?? {})
		};
		const result = await this.opts.client.send(event);
		return result.ids?.[0] ?? null;
	}

	/**
	 * EW-742 P4 T31 — enqueue with platform-canonical
	 * `JobEnqueueOptions`. Translates each field onto Inngest's
	 * SendEvent carrier per `providers.md` § Inngest:
	 *
	 *   - `idempotencyKey`   → top-level `event.id` (Inngest dedup)
	 *   - `tenantId`         → `event.data._ew.tenantId`
	 *   - `concurrencyKey`   → `event.data._ew.concurrencyKey`
	 *   - `tags`             → `event.data._ew.tags`
	 *   - `maxDurationSeconds` / `machineHint` → `event.data._ew.*`
	 *
	 * Per-tenant Inngest CLIENT selection happens before this call —
	 * the caller picks the right `Inngest` client via the plugin's
	 * `dispatchersBuilder` hook (SaaS only per providers.md).
	 *
	 * `extraOverrides` is shallow-merged on top so operators can still
	 * pass Inngest-native top-level event fields (`user`, custom v3
	 * SDK fields) that have no `JobEnqueueOptions` equivalent.
	 */
	async enqueue(
		eventName: string,
		data: Readonly<Record<string, unknown>>,
		enqueueOptions: JobEnqueueOptions,
		extraOverrides?: Partial<Omit<InngestSendEvent, 'name' | 'data'>>
	): Promise<string | null> {
		const { topLevel, dataMeta } = mapEnqueueOptions(enqueueOptions);
		const fullName = this.opts.eventNamespace ? `${this.opts.eventNamespace}/${eventName}` : eventName;
		const mergedData = Object.keys(dataMeta).length > 0 ? { ...data, _ew: dataMeta } : data;
		const event: InngestSendEvent = {
			name: fullName,
			data: mergedData,
			...topLevel,
			...(extraOverrides ?? {})
		};
		const result = await this.opts.client.send(event);
		return result.ids?.[0] ?? null;
	}

	/** Send a batch of events in one call. Returns Inngest-assigned ids. */
	async sendBatch(events: readonly { name: string; data: unknown }[]): Promise<readonly string[]> {
		const namespaced = events.map((e) => ({
			name: this.opts.eventNamespace ? `${this.opts.eventNamespace}/${e.name}` : e.name,
			data: e.data
		}));
		const result = await this.opts.client.send(namespaced);
		return result.ids ?? [];
	}

	/**
	 * Define an Inngest function and remember it for `factory.functions`
	 * (which the operator typically hands to `serve({ functions })`).
	 *
	 * Returns the function object so the operator can also reference it
	 * directly if they want fine-grained control.
	 */
	defineFunction(
		config: Readonly<Record<string, unknown>>,
		trigger: Readonly<Record<string, unknown>>,
		handler: (...args: unknown[]) => Promise<unknown>
	): InngestFunction {
		if (!this.opts.client.createFunction) {
			throw new Error(
				'InngestDispatcherFactory: client.createFunction is unavailable. Ensure you pass a v3 Inngest client.'
			);
		}
		const fn = this.opts.client.createFunction(config, trigger, handler);
		this.registeredFunctions.push(fn);
		return fn;
	}

	/** All functions defined through this factory — pass to `serve({ functions })`. */
	get functions(): readonly InngestFunction[] {
		return this.registeredFunctions;
	}
}
