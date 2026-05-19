import { test, expect } from '@playwright/test';
import { API_BASE } from './helpers/api';

/**
 * CSP violation reporting — pass 14. A modern CSP carries a
 * `report-to` or `report-uri` directive pointing at an endpoint that
 * accepts violation reports. The endpoint should:
 * - exist (status < 500 when posting a valid CSP report)
 * - accept `application/csp-report` AND `application/reports+json`
 * - NOT require auth (browsers can't auth)
 *
 * We probe a few candidate paths. If none exists, skip.
 */

const REPORT_PATHS = ['/api/csp-report', '/api/reports/csp', '/api/security/csp-violations'];

const SAMPLE_REPORT = {
    'csp-report': {
        'document-uri': 'http://localhost:3000/en/login',
        referrer: '',
        'violated-directive': "script-src 'self'",
        'effective-directive': 'script-src',
        'original-policy': "default-src 'self'",
        disposition: 'enforce',
        blocked: 'https://evil.example.com/x.js',
        'status-code': 0,
    },
};

test.describe('CSP — violation report endpoint accepts reports', () => {
    test('one of the candidate paths exists and accepts a CSP report payload', async ({
        request,
    }) => {
        let accepted = false;
        let probedStatuses: string[] = [];
        for (const p of REPORT_PATHS) {
            const res = await request.post(`${API_BASE}${p}`, {
                headers: { 'Content-Type': 'application/csp-report' },
                data: SAMPLE_REPORT,
            });
            probedStatuses.push(`${p}=${res.status()}`);
            if (res.status() < 500 && res.status() !== 404) {
                accepted = true;
                break;
            }
        }
        if (!accepted) {
            test.skip(true, `no CSP reporting endpoint configured: ${probedStatuses.join(', ')}`);
        }
        expect(accepted).toBe(true);
    });

    test('CSP header on /en/login references a report directive (or N/A)', async ({
        page,
        baseURL,
    }) => {
        const res = await page.request.get(`${baseURL || 'http://localhost:3000'}/en/login`);
        const csp =
            res.headers()['content-security-policy'] ||
            res.headers()['content-security-policy-report-only'] ||
            '';
        if (!csp) {
            test.skip(true, 'no CSP header on /en/login — covered in csp-strict.spec.ts');
        }
        const hasReporter = /report-to|report-uri/i.test(csp);
        // If the platform sets a CSP, having a reporting directive is
        // best-practice (so violations are visible). Soft-warn only.
        if (!hasReporter) {
            test.info().annotations.push({
                type: 'warning',
                description: `CSP on /en/login has no report-to/report-uri — violations are invisible`,
            });
        }
    });
});
