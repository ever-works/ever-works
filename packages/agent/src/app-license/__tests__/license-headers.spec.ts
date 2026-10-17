import { LICENSE_HEADER_SCAN_BYTES } from '@ever-works/contracts';
import { licenseHeadOf, scanLicenseHeaders, scanLicenseHeaderText } from '../license-headers';

/** APW-03 T41 (FR-54) — header scanning reads the first 2 KiB and nothing else. */
describe('license headers (APW-03 T41)', () => {
    it('reads SPDX-License-Identifier tags in comment styles, de-duplicated', () => {
        const text = [
            '// SPDX-License-Identifier: MIT OR Apache-2.0',
            '/* SPDX-License-Identifier: MIT OR Apache-2.0 */',
            '# SPDX-License-Identifier: BUSL-1.1',
            '<!-- SPDX-License-Identifier: AGPL-3.0-only -->',
        ].join('\n');
        expect(scanLicenseHeaderText(text)).toEqual([
            'MIT OR Apache-2.0',
            'BUSL-1.1',
            'AGPL-3.0-only',
        ]);
    });

    it('reads `@license` tags and a LicenseRef id, and drops prose', () => {
        expect(scanLicenseHeaderText('/**\n * @license MIT\n */')).toEqual(['MIT']);
        expect(scanLicenseHeaderText('// SPDX-License-Identifier: LicenseRef-Acme-1')).toEqual([
            'LicenseRef-Acme-1',
        ]);
        expect(scanLicenseHeaderText('/** @license see the LICENSE file for details */')).toEqual(
            [],
        );
    });

    it('never reads past the first 2 KiB', () => {
        const padding = 'x'.repeat(LICENSE_HEADER_SCAN_BYTES);
        expect(scanLicenseHeaderText(`${padding}\n// SPDX-License-Identifier: MIT`)).toEqual([]);
        expect(
            Buffer.byteLength(licenseHeadOf('é'.repeat(LICENSE_HEADER_SCAN_BYTES)), 'utf8'),
        ).toBeLessThanOrEqual(LICENSE_HEADER_SCAN_BYTES);
    });

    it('scanLicenseHeaders answers one finding per file and expression', () => {
        expect(
            scanLicenseHeaders([
                { path: 'a.ts', head: '// SPDX-License-Identifier: MIT' },
                { path: 'b.ts', head: 'no header' },
                { path: 'c.ts', head: '// SPDX-License-Identifier: BUSL-1.1' },
            ]),
        ).toEqual([
            { path: 'a.ts', spdx: 'MIT' },
            { path: 'c.ts', spdx: 'BUSL-1.1' },
        ]);
    });
});
