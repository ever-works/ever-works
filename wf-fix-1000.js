export const meta = {
    name: 'ever-works-e2e-1000-fix-wave',
    description: 'Fix failing flow specs by probing real platform behavior and correcting only the failing assertions',
    phases: [{ title: 'Fix', detail: 'one agent per failing spec file' }],
};

// args = array of { file, failures: string[] }
const FILES = Array.isArray(args) ? args : [];

const FIX_CONTEXT = `
You are FIXING one existing Playwright e2e spec under
C:/Coding/Worktrees/wt-e2e-real-integration/apps/web/e2e/ that has failing test(s). The stack is
RUNNING (API http://127.0.0.1:3100, web http://127.0.0.1:3000, MailHog http://127.0.0.1:8025;
sqlite in-memory; authenticated storageState at e2e/.auth/user.json).

RULES:
- PROBE the REAL platform before changing an assertion: curl the live API as a throwaway user
  (register → {access_token}; login DTO accepts ONLY {email,password}), and/or read the real
  controller/component source, to learn the ACTUAL status/shape/message/redirect/selector, then make
  the assertion match REALITY.
- Fix ONLY the failing test(s)/assertions/selectors/setup. Do NOT change passing tests in the file.
  Do NOT touch any other file (no helpers/product/config).
- PRESERVE each flow's intent. If the platform genuinely behaves differently than assumed, assert
  the TRUE behaviour + add a one-line comment. Never assert a fictional clean code for a path that
  really errors. If a feature/endpoint is absent, degrade with .or()/skip-on-404 and annotate.
- KNOWN FACTS: agent assign-task 500s at enqueue but records an AgentRun (assert the record, not
  completion). /api/chat 200 SSE then stalls without an LLM key (env-adaptive). e2e SMTP delivery
  FAILS ("Missing credentials for PLAIN") so MailHog inbox stays empty even though its HTTP API is
  up → mail-content assertions MUST be best-effort. browser.newContext() inherits the storageState
  cookie → use { storageState: { cookies: [], origins: [] } } for anon. next-dev nested routes can
  render in CI but 404 locally → assert with .or() and branch. magic-link issuance 5/60s throttle →
  tolerate/skip on 429. Duplicate task-assignee → 500. conversation message-append → 201. Org
  /{slug} get is a global resolver (200). Run MUTATIONS on FRESH registerUserViaAPI users.
- Reuse helpers under e2e/helpers/. Do NOT run \`pnpm exec playwright test\` (re-runs setup + contends
  the shared stack); curl read-only + read source freely. Keep repo style. Return the result.
`;

phase('Fix');

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['file', 'fixed', 'summary'],
    properties: {
        file: { type: 'string' },
        fixed: { type: 'boolean' },
        whatWasWrong: { type: 'string' },
        summary: { type: 'string' },
    },
};

const results = await parallel(
    FILES.map((f) => () =>
        agent(
            `${FIX_CONTEXT}\n\n=== FIX THIS FILE ===\napps/web/e2e/${f.file}\n\nFailing test(s) + observed errors:\n${(f.failures || []).map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nProbe the real platform, fix ONLY the failing assertions to match reality, preserve intent, leave passing tests untouched. Return the structured result.`,
            { label: f.file.replace('flow-', '').replace('.spec.ts', '').slice(0, 40), phase: 'Fix', schema: SCHEMA },
        ),
    ),
);
const ok = results.filter(Boolean);
log(`Fix wave: ${ok.filter((r) => r.fixed).length}/${FILES.length} fixed`);
return ok;
