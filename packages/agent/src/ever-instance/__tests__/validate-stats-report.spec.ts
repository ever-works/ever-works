import { readFileSync } from 'fs';
import { join } from 'path';
import { validateStatsReport, validateStatsReportBody } from '../validate-stats-report';

/**
 * The receiver's checks, applied to the exact body before anything is sent:
 * 16 KiB, well-formed JSON, one key per object, integers written as integers,
 * then the strict schema — with the refused field named by its JSON pointer.
 */
const works = () =>
    JSON.parse(
        readFileSync(
            join(__dirname, '..', 'contract', 'fixtures', 'stats', 'valid', 'works.json'),
            'utf8',
        ),
    ) as Record<string, unknown> & { counts: Record<string, unknown> };

describe('validateStatsReport / validateStatsReportBody', () => {
    it('accepts the published Works golden, as an object and as bytes', () => {
        expect(validateStatsReport(works())).toEqual({ ok: true });
        expect(validateStatsReportBody(JSON.stringify(works()))).toEqual({ ok: true });
    });

    it('refuses a body above 16 KiB before parsing it', () => {
        const body = JSON.stringify({ ...works(), pad: 'x'.repeat(17_000) });
        expect(validateStatsReportBody(body)).toEqual({
            ok: false,
            errors: [{ path: '', code: 'too_large', message: 'body exceeds 16384 bytes' }],
        });
    });

    it('refuses a key written twice, at its path', () => {
        const body = JSON.stringify(works()).replace(
            '"country":"ZZ"',
            '"country":"ZZ","country":"DE"',
        );
        expect(validateStatsReportBody(body)).toMatchObject({
            ok: false,
            errors: [{ path: '/country', code: 'duplicate_key' }],
        });
    });

    it('refuses a number written with a fraction or an exponent', () => {
        const body = JSON.stringify(works()).replace('"runs":224', '"runs":224.0');
        expect(validateStatsReportBody(body)).toMatchObject({
            ok: false,
            errors: [{ path: '/aggregates/runs', code: 'not_an_integer' }],
        });
        const exponent = JSON.stringify(works()).replace('"runs":224', '"runs":2.24e2');
        expect(validateStatsReportBody(exponent)).toMatchObject({ ok: false });
    });

    it('refuses something that is not JSON', () => {
        expect(validateStatsReportBody('{"schema":')).toMatchObject({
            ok: false,
            errors: [{ code: 'invalid_json' }],
        });
        expect(validateStatsReportBody('{} trailing')).toMatchObject({
            ok: false,
            errors: [{ code: 'invalid_json' }],
        });
    });

    it('names an unknown field by its own path and reports the report’s own product only', () => {
        const report = works();
        report.counts = { ...report.counts, invoices: 3 };
        const result = validateStatsReport(report);
        expect(result).toEqual({
            ok: false,
            errors: [
                {
                    path: '/counts/invoices',
                    code: 'unknown_field',
                    message: 'field not in the published schema',
                },
            ],
        });
    });

    it('never repeats the refused value in its message', () => {
        const report = { ...works(), country: 'alice@example.com' };
        const result = validateStatsReport(report);
        expect(result.ok).toBe(false);
        expect(JSON.stringify(result)).not.toContain('alice');
    });
});
