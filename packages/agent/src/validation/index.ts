/**
 * ENTITY-FREE validation DTOs — shared request-body shapes that carry
 * class-validator / Swagger decorators and import NOTHING from the entity
 * graph.
 *
 * Why this subpath exists: `@ever-works/agent/dto` is the general DTO
 * barrel, and it transitively loads `work.entity` → `user.entity` →
 * `work-generation-history.entity` → the items-generator DTOs. That is
 * fine for API modules that already live in the entity world, but an
 * `apps/api` DTO file that only needs ONE small shared body shape should
 * not have to drag the whole graph in with it (under the api test runner
 * that import order resolves a pre-existing entity import cycle to
 * `undefined` and fails the suite before a single test runs).
 *
 * Rule for anything added here: no entity imports, no Nest modules, no
 * repositories — decorators plus `@ever-works/contracts` types only.
 */
export { MergePolicyDto } from '../dto/merge-policy.dto';
