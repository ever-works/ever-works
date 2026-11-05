// H-22: any value that flows into a filesystem path component or a SQL
// parameter on the worker side originates here, in the Trigger.dev payload.
// The payload arrives untrusted (Trigger.dev signs delivery but doesn't
// re-validate the body shape), so we re-assert the shape locally before
// handing values to downstream code that builds paths like
// `<BASE_TEMP_DIR>/<userId>/<workId>` (see `getWorkspacePath`). UUID v4 shape
// — adjust if the platform standardises on a different ID format.
//
// A dependency-free leaf on purpose. It used to live in `task-context.utils`,
// which also imports the agent entity barrel, the plugin hydrator and the
// internal API client, so every task that only needed this guard dragged that
// whole graph in with it. Under CI load that cold import alone took past the
// 120 s hook budget of `agent-task-execute.task.spec.ts` (stage run
// 41605694347); measured locally it is ~21 s of the spec's ~49 s.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
        throw new Error(
            `Invalid ${field}: expected a UUID, got ${typeof value === 'string' ? JSON.stringify(value) : typeof value}`,
        );
    }
    return value;
}
