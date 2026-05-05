import type { IngressStrategy } from './strategy.js';
import { NginxIngressStrategy } from './nginx.strategy.js';
import { TraefikIngressStrategy } from './traefik.strategy.js';
import { GenericIngressStrategy } from './generic.strategy.js';

/**
 * Strategy registry for Ingress controllers. Built-ins ship for nginx and
 * Traefik; everything else maps to a generic fallback.
 */
export class IngressStrategyRegistry {
	private readonly byController = new Map<string, IngressStrategy>();
	private readonly fallback: IngressStrategy;

	constructor(fallback: IngressStrategy = new GenericIngressStrategy()) {
		this.fallback = fallback;
		this.register(new NginxIngressStrategy());
		this.register(new TraefikIngressStrategy());
	}

	register(strategy: IngressStrategy): void {
		if (strategy.controller) {
			this.byController.set(strategy.controller, strategy);
		}
	}

	/**
	 * Look up a strategy for an `IngressClass.spec.controller` value.
	 *
	 * Returns the registered strategy if any, otherwise the generic
	 * fallback. Pass `undefined` (no IngressClass selected) and you'll get
	 * the fallback too.
	 */
	selectStrategy(controller: string | undefined): IngressStrategy {
		if (!controller) return this.fallback;
		return this.byController.get(controller) ?? this.fallback;
	}

	hasStrategyFor(controller: string): boolean {
		return this.byController.has(controller);
	}

	knownControllers(): string[] {
		return Array.from(this.byController.keys());
	}
}

export const defaultIngressStrategyRegistry = new IngressStrategyRegistry();
