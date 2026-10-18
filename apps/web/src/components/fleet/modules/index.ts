/**
 * Fleet hub (FL-01, README D9) — where Fleet modules register what renders
 * IN THE BROWSER: Overview blocks (`registerOverviewBlock`), computer actions
 * (`registerComputerAction`) and "Add computer ▾" entries
 * (`registerAddComputerItem`). Each epic adds ONE file beside this one
 * (`./fl-NN-<topic>.ts`) and ONE import line below; every component it
 * registers must be client-safe (no `server-only` import), because this file
 * is imported by client components.
 *
 * Tabs and the session page are rendered on the server: register those in a
 * file imported by `./server.ts` instead.
 *
 * Registered today: nothing (FL-01 renders its own blocks directly).
 */
export {};
