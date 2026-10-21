import { randomUUID } from 'crypto';
import { newRelayReplicaId, type RelayBus, type RelayBusHealth } from './relay-bus';

/**
 * The single-replica relay bus: no peers, nothing published, nothing
 * received — every relay runs on its own process's registry, exactly as it
 * did before the bus existed. `claimOnce` is honoured in this process (a
 * single-use token stays single-use on one replica; with two replicas and no
 * bus — which `FLEET_RELAY_REQUIRE_BUS` makes a boot error — it is per
 * replica, CONTRACTS R-7).
 */
export class InProcessRelayBus implements RelayBus {
    readonly mode = 'single-replica' as const;
    readonly replicaId = newRelayReplicaId(randomUUID());
    private readonly claimed = new Map<string, number>();

    constructor(private readonly now: () => number = () => Date.now()) {}

    publish(): boolean {
        return false;
    }

    sendTo(): boolean {
        return false;
    }

    subscribe(): () => void {
        return () => undefined;
    }

    peers(): string[] {
        return [];
    }

    onPeerChange(): () => void {
        return () => undefined;
    }

    health(): RelayBusHealth {
        return { configured: false, mode: 'single-replica', status: 'up' };
    }

    async claimOnce(key: string, ttlMs: number): Promise<boolean> {
        const now = this.now();
        if (this.claimed.size > 1_000) {
            for (const [held, until] of this.claimed) if (until <= now) this.claimed.delete(held);
        }
        const until = this.claimed.get(key);
        if (until !== undefined && until > now) return false;
        this.claimed.set(key, now + Math.max(1, ttlMs));
        return true;
    }

    async close(): Promise<void> {
        this.claimed.clear();
    }
}
