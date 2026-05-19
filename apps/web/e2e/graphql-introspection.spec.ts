import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * GraphQL introspection — pass 14. If a GraphQL endpoint exists,
 * production posture demands that `__schema` introspection is
 * disabled. An exposed schema gives attackers a complete API map
 * including mutations, types, and field names.
 *
 * We probe the common `/graphql` and `/api/graphql` paths. If neither
 * exists, skip (no GraphQL surface to test). If one does, the
 * introspection query must NOT return a full schema object.
 */

const GQL_PATHS = ['/graphql', '/api/graphql', '/api/v1/graphql'];
const INTROSPECTION_QUERY = '{__schema{types{name}}}';

test.describe('GraphQL — introspection disabled in production', () => {
    test('introspection query is blocked or rejected', async ({ request }) => {
        let foundPath: string | null = null;
        for (const p of GQL_PATHS) {
            const probe = await request.post(`${API_BASE}${p}`, {
                data: { query: '{__typename}' },
            });
            if (probe.status() !== 404) {
                foundPath = p;
                break;
            }
        }
        if (!foundPath) {
            test.skip(true, 'no GraphQL endpoint exposed in this env');
        }
        const res = await request.post(`${API_BASE}${foundPath}`, {
            data: { query: INTROSPECTION_QUERY },
        });
        // The query must NOT return a populated schema. Acceptable:
        //   - 4xx rejecting the query
        //   - 200 with `errors` field signaling introspection disabled
        //   - 200 with `data.__schema = null`
        if (res.status() >= 400 && res.status() < 500) {
            // Rejected — good.
            return;
        }
        const body = await res.json();
        if (body?.errors && body.errors.length > 0) {
            // Server returned a GraphQL error — likely "introspection
            // disabled". This is the expected production posture.
            return;
        }
        const types = body?.data?.__schema?.types;
        expect(
            Array.isArray(types) && types.length > 0,
            `GraphQL introspection leaked ${types?.length ?? 0} types in production`,
        ).toBe(false);
    });
});
