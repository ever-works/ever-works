// Shim for `server-only` under Vitest. Next.js provides this module at
// build time as a marker that throws if it's accidentally bundled into
// a client component. In unit tests we just need it to resolve to an
// empty module so server-side helpers can be imported.
export {};
