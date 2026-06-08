import { z } from 'zod';

/**
 * M-08 / EW-717 (deserialization): defense-in-depth shape validation for the
 * account-import Server Action args. The API tier has its own DTO check, but a
 * malformed/hostile shape at this boundary (oversized payload, wrong type)
 * should fail fast in the web tier rather than be proxied verbatim and force
 * unbounded memory + RPC body size before the upstream call.
 *
 * The schema is deliberately permissive on the deep element shape (the export
 * payload is large and varied) but enforces hard COUNT caps on the nested
 * import arrays. `works`/`userPlugins` are the confirmed v1 arrays; the rest
 * are the v2 export tail (optional → a no-op when absent). `.catchall` keeps
 * any future field forward-compatible. The same `.max()` pattern already
 * guards the `resolutions` array in `applyImport`.
 *
 * Extracted into this pure (non-`'use server'`) module so the caps can be
 * unit-tested directly.
 */
export const accountExportPayloadSchema = z
    .object({
        // Top-level fields the API tier requires
        version: z.union([z.string().max(64), z.number()]).optional(),
        user: z.unknown().optional(),
        data: z
            .object({
                works: z.array(z.unknown()).max(50_000).optional(),
                userPlugins: z.array(z.unknown()).max(5_000).optional(),
                agents: z.array(z.unknown()).max(5_000).optional(),
                skills: z.array(z.unknown()).max(50_000).optional(),
                tasks: z.array(z.unknown()).max(100_000).optional(),
                taskChat: z.array(z.unknown()).max(500_000).optional(),
            })
            .catchall(z.unknown())
            .optional(),
    })
    .catchall(z.unknown());
