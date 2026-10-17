// Webhooks v2 (EW-P1-5) — the domain-event fan-out. A sub-export of its own
// (not the `services` barrel): it reaches the domain-event relay and the
// plugin delivery graph, which every `@ever-works/agent/services` importer
// would otherwise load (and type-check) too.
export * from '../services/webhook-domain-event-fanout.service';
