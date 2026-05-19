import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * Metrics endpoint — pass 14. Prometheus-style `/metrics` is the
 * standard observability surface. If exposed, it should:
 * - return text/plain (NOT application/json)
 * - carry `# HELP` and `# TYPE` directive lines
 * - expose at least one well-known series (http_requests_total,
 *   process_cpu_seconds_total, nodejs_version_info)
 * - NOT require auth (most scrapers can't auth, but it should be
 *   network-restricted at the cluster level)
 *
 * If `/api/metrics` returns 404, the endpoint isn't wired here — skip.
 */

const METRIC_PATHS = ['/api/metrics', '/metrics'];

test.describe('Metrics — Prometheus-format /metrics endpoint', () => {
    test('one of the candidate paths returns Prometheus-shaped text', async ({ request }) => {
        let body = '';
        let foundPath: string | null = null;
        for (const p of METRIC_PATHS) {
            const res = await request.get(`${API_BASE}${p}`);
            if (res.status() === 200) {
                const ct = res.headers()['content-type'] || '';
                if (/text\/plain|application\/openmetrics-text/.test(ct)) {
                    body = await res.text();
                    foundPath = p;
                    break;
                }
            }
        }
        if (!foundPath) {
            test.skip(true, 'no /metrics-shaped endpoint exposed in this env');
        }
        // Prometheus exposition format always carries `# HELP` and
        // `# TYPE` directive lines for each series.
        expect(body, 'no # HELP directive').toMatch(/^# HELP /m);
        expect(body, 'no # TYPE directive').toMatch(/^# TYPE /m);
        // At least one of the canonical series should be present.
        const canonical =
            /(?:http_requests_total|process_cpu_seconds_total|nodejs_version_info|process_start_time_seconds)/.test(
                body,
            );
        expect(canonical, 'no canonical Prometheus series found').toBe(true);
    });

    test('/api/metrics is not exposed as JSON', async ({ request }) => {
        const res = await request.get(`${API_BASE}/api/metrics`);
        if (res.status() === 404) {
            test.skip(true, '/api/metrics not exposed');
        }
        const ct = res.headers()['content-type'] || '';
        // JSON metrics endpoint = misconfig — Prometheus scrapers can't
        // parse it. Allow text/plain or openmetrics-text only.
        expect(/application\/json/.test(ct), `/api/metrics returned JSON: ${ct}`).toBe(false);
    });
});
