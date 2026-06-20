/**
 * Public subpath for conformance test suites that concrete plugin
 * packages run against themselves.
 *
 * Why a dedicated subpath:
 *   - The actual test files live at `src/contracts/__tests__/...`
 *     which the package's tsup entry list deliberately omits
 *     (test-only code shouldn't ship in the default bundle).
 *   - Concrete plugin packages (BullMQ, pg-boss, Temporal, Inngest,
 *     pgvector, qdrant, …) need an importable entry point so they can
 *     `import { runJobRuntimeContractSuite } from
 *     '@ever-works/plugin/contracts-conformance'` from THEIR tests and
 *     prove their implementation satisfies the contract — same shape
 *     as the suite the contract file self-applies against the fake.
 *
 * Peer dependency: consumers MUST have `vitest` installed (it is
 * already a dev-dep in every `packages/plugins/*` package; consumers
 * outside the workspace need to add it themselves).
 */
export {
	runJobRuntimeContractSuite
} from '../contracts/__tests__/job-runtime-conformance.spec.js';
export type { JobRuntimeContractOptions } from '../contracts/__tests__/job-runtime-conformance.spec.js';
export {
	InMemoryJobRuntimeProvider,
	createInMemoryJobRuntimeProvider
} from '../contracts/__tests__/fakes/in-memory-job-runtime-provider.js';
