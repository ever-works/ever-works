import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

/**
 * Browser code must not reach a BFF route with a bare `fetch`.
 *
 * `apps/web/src/app/api/**` is a BFF: the browser calls it, and it calls the
 * platform. The per-tab workspace selector (`x-ever-workspace`) is what tells it
 * which Organization the tab is looking at, and `proxy.ts`'s matcher DELIBERATELY
 * excludes `/api`, so nothing upstream can add it. A BFF route only ever receives
 * the selector when the client sends it.
 *
 * Getting that wrong does not fail loudly. The API answers a missing Organization
 * scope with an EMPTY PAYLOAD AND HTTP 200, so the symptom is "my data vanished",
 * never a stack trace — and where it does fail closed, `serverFetch` throws and a
 * caller swallows it. That combination produced four production defects in one day
 * (EW-783, EW-786, EW-787, EW-788), one of which left the in-app AI assistant unable
 * to perform ANY data action for ANY user for twelve days without a single error
 * being visible anywhere.
 *
 * Use `browserApiFetch` from `@/lib/api/browser-api`, which is a drop-in for
 * `fetch`. If you own your own transport and cannot route through it, use
 * `applyBrowserWorkspaceScope` from the same module.
 *
 * See Workspace `knowledge/design/EVER_WORKS_BFF_WORKSPACE_SCOPE.md`.
 */
const UNSCOPED_BFF_CALL =
    'Use browserApiFetch from @/lib/api/browser-api instead of a bare fetch to a /api/ route — it stamps the x-ever-workspace selector the BFF needs to resolve your Organization. Without it the call silently runs in the personal scope (empty results, HTTP 200) or fails closed. If this route genuinely must be scope-free, add an eslint-disable with a comment saying why.';

const UNSCOPED_XHR =
    'XMLHttpRequest cannot carry the x-ever-workspace selector unless you set it explicitly. Prefer browserApiFetch; if you need XHR for upload progress, call applyBrowserWorkspaceScope and setRequestHeader for each entry, and say so in a comment.';

const eslintConfig = [
    ...nextCoreWebVitals,
    {
        files: ['src/**/*.{ts,tsx}'],
        ignores: [
            // BFF routes run on the server and talk to the platform via
            // API_URL, not to themselves. They are the CONSUMERS of the
            // selector, not senders.
            'src/app/api/**',
            // Specs assert on transport behaviour and legitimately stub or
            // inspect raw fetch.
            'src/**/*.spec.ts',
            'src/**/*.spec.tsx',
            'src/**/*.unit.spec.ts',
            'src/**/*.unit.spec.tsx',
            // The one module allowed to call fetch directly — it is what adds
            // the header.
            'src/lib/api/browser-api.ts',
        ],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'CallExpression[callee.name="fetch"][arguments.0.value=/^\\/api\\//]',
                    message: UNSCOPED_BFF_CALL,
                },
                {
                    selector:
                        'CallExpression[callee.name="fetch"][arguments.0.quasis.0.value.raw=/^\\/api\\//]',
                    message: UNSCOPED_BFF_CALL,
                },
                {
                    selector: 'NewExpression[callee.name="XMLHttpRequest"]',
                    message: UNSCOPED_XHR,
                },
            ],
        },
    },
];

export default eslintConfig;
