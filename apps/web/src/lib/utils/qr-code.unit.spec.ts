import { describe, expect, it } from 'vitest';
import {
    QR_MAX_VERSION,
    encodeQrCode,
    qrByteCapacity,
    qrCodeToSvgPath,
    qrCodeViewBoxSize,
    qrFunctionModuleMap,
    type QrCodeMatrix,
} from './qr-code';

/**
 * The encoder is hand-rolled, so "it renders a square of dots" is not
 * evidence of anything. These tests DECODE the finished matrix back to
 * the payload with an independently written reader — unmask, zigzag
 * read, de-interleave — and separately verify the Reed–Solomon parity
 * by evaluating the codeword polynomial at the generator's roots.
 *
 * The syndrome check is deliberately a different formulation from the
 * encoder's polynomial long division: if both were the same algorithm,
 * agreeing would prove nothing.
 */

// ── GF(256) helpers for the syndrome check (primitive poly 0x11D) ────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** True when every syndrome of the codeword block is zero. */
function hasValidParity(block: readonly number[], eccLength: number): boolean {
    for (let i = 0; i < eccLength; i++) {
        const root = GF_EXP[i];
        let value = 0;
        for (const coefficient of block) {
            value = gfMul(value, root) ^ coefficient;
        }
        if (value !== 0) return false;
    }
    return true;
}

// ── an independent reader ───────────────────────────────────────────

const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292];
const ECC_PER_BLOCK_L = [7, 10, 15, 20, 26, 18, 20, 24, 30];
const NUM_BLOCKS_L = [1, 1, 1, 1, 1, 2, 2, 2, 2];

function maskBit(mask: number, row: number, col: number): boolean {
    switch (mask) {
        case 0:
            return (row + col) % 2 === 0;
        case 1:
            return row % 2 === 0;
        case 2:
            return col % 3 === 0;
        case 3:
            return (row + col) % 3 === 0;
        case 4:
            return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
        case 5:
            return ((row * col) % 2) + ((row * col) % 3) === 0;
        case 6:
            return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
        default:
            return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    }
}

/** Read the interleaved codeword stream out of a (still masked) matrix. */
function readCodewords(matrix: QrCodeMatrix, mask: number, total: number): number[] {
    const { size, modules } = matrix;
    const version = (size - 17) / 4;
    const isFunction = qrFunctionModuleMap(version);

    const bits: number[] = [];
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const col = right - j;
                const upward = ((right + 1) & 2) === 0;
                const row = upward ? size - 1 - vert : vert;
                if (isFunction[row][col]) continue;
                const masked = maskBit(mask, row, col);
                bits.push(modules[row][col] !== masked ? 1 : 0);
            }
        }
    }

    const codewords: number[] = [];
    for (let i = 0; i + 7 < bits.length && codewords.length < total; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        codewords.push(byte);
    }
    return codewords;
}

/**
 * Decode a symbol back to its payload, or null when no mask produces a
 * parity-clean, well-formed byte-mode message.
 *
 * Brute-forcing the mask (instead of parsing the format bits) means a
 * wrong mask cannot accidentally pass: it has to survive the RS parity
 * check on every block AND yield a byte-mode header.
 */
function decode(matrix: QrCodeMatrix): string | null {
    const version = (matrix.size - 17) / 4;
    const index = version - 1;
    const eccLength = ECC_PER_BLOCK_L[index];
    const numBlocks = NUM_BLOCKS_L[index];
    const total = TOTAL_CODEWORDS[index];
    const blockLength = total / numBlocks;
    const dataPerBlock = blockLength - eccLength;

    for (let mask = 0; mask < 8; mask++) {
        const stream = readCodewords(matrix, mask, total);
        if (stream.length < total) continue;

        // De-interleave: data codewords first (round-robin across
        // blocks), then the ecc codewords the same way.
        const blocks: number[][] = Array.from({ length: numBlocks }, () => []);
        let cursor = 0;
        for (let i = 0; i < dataPerBlock; i++) {
            for (let b = 0; b < numBlocks; b++) blocks[b].push(stream[cursor++]);
        }
        const eccBlocks: number[][] = Array.from({ length: numBlocks }, () => []);
        for (let i = 0; i < eccLength; i++) {
            for (let b = 0; b < numBlocks; b++) eccBlocks[b].push(stream[cursor++]);
        }

        const parityOk = blocks.every((block, b) =>
            hasValidParity(block.concat(eccBlocks[b]), eccLength),
        );
        if (!parityOk) continue;

        const data = blocks.flat();
        const mode = data[0] >> 4;
        if (mode !== 0b0100) continue;
        const length = ((data[0] & 0x0f) << 4) | (data[1] >> 4);
        const bytes: number[] = [];
        for (let i = 0; i < length; i++) {
            bytes.push(((data[1 + i] & 0x0f) << 4) | (data[2 + i] >> 4));
        }
        return new TextDecoder().decode(new Uint8Array(bytes));
    }
    return null;
}

describe('encodeQrCode', () => {
    it('round-trips a short ASCII payload', () => {
        const matrix = encodeQrCode('ever-works');
        expect(matrix).not.toBeNull();
        expect(decode(matrix as QrCodeMatrix)).toBe('ever-works');
    });

    it('round-trips a realistic enrollment payload across a multi-block version', () => {
        // Shaped like what the enroll dialog encodes: an API base plus a
        // 43-character base64url token. Long enough to push past the
        // single-block versions and to require version-info bits.
        const payload =
            'everworks://enroll?api=https://api.example.com&token=' +
            'aZ9-_bcdefghijklmnopqrstuvwxyzABCDEFGHIJK12' +
            '&name=Office%20workstation&kind=node';
        const matrix = encodeQrCode(payload);
        expect(matrix).not.toBeNull();
        // ≥ v6 (size 41) — the first version with two EC blocks, so the
        // interleave is genuinely exercised rather than a no-op.
        expect((matrix as QrCodeMatrix).size).toBeGreaterThanOrEqual(41);
        expect(decode(matrix as QrCodeMatrix)).toBe(payload);
    });

    it('round-trips a payload large enough to carry version-info bits', () => {
        // ≥ v7 symbols embed two BCH-coded copies of the version number
        // near the far finders; those areas must be reserved, not data.
        const payload = 'v'.repeat(200);
        const matrix = encodeQrCode(payload) as QrCodeMatrix;
        expect(matrix.size).toBe(53); // version 9
        expect(decode(matrix)).toBe(payload);
    });

    it('round-trips multi-byte UTF-8', () => {
        const payload = 'nœud — 節点 — узел';
        const matrix = encodeQrCode(payload);
        expect(decode(matrix as QrCodeMatrix)).toBe(payload);
    });

    it('sizes the symbol to 4 × version + 17 and grows with the payload', () => {
        const small = encodeQrCode('x') as QrCodeMatrix;
        expect((small.size - 17) % 4).toBe(0);
        expect(small.size).toBe(21); // version 1

        const larger = encodeQrCode('x'.repeat(120)) as QrCodeMatrix;
        expect(larger.size).toBeGreaterThan(small.size);
    });

    it('returns null rather than a wrong code for unsupported input', () => {
        expect(encodeQrCode('')).toBeNull();
        // One byte past the largest supported version.
        expect(encodeQrCode('x'.repeat(qrByteCapacity(QR_MAX_VERSION) + 1))).toBeNull();
        // …and exactly at the limit it still encodes.
        expect(encodeQrCode('x'.repeat(qrByteCapacity(QR_MAX_VERSION)))).not.toBeNull();
    });

    it('places the three finder patterns and the timing rows', () => {
        const matrix = encodeQrCode('finder-check') as QrCodeMatrix;
        const { size, modules } = matrix;

        for (const [top, left] of [
            [0, 0],
            [0, size - 7],
            [size - 7, 0],
        ]) {
            // Dark 7×7 border, light ring, dark 3×3 core.
            expect(modules[top][left]).toBe(true);
            expect(modules[top + 1][left + 1]).toBe(false);
            expect(modules[top + 3][left + 3]).toBe(true);
        }

        // Timing patterns alternate, starting dark at index 8.
        for (let i = 8; i < size - 8; i++) {
            expect(modules[6][i]).toBe(i % 2 === 0);
            expect(modules[i][6]).toBe(i % 2 === 0);
        }

        // The always-dark module below the top-left format area.
        expect(modules[size - 8][8]).toBe(true);
    });
});

describe('qrCodeToSvgPath', () => {
    it('emits one sub-path per dark module, offset by the quiet zone', () => {
        const matrix = encodeQrCode('svg') as QrCodeMatrix;
        const path = qrCodeToSvgPath(matrix, 2);

        const darkCount = matrix.modules.flat().filter(Boolean).length;
        expect(path.split('M').length - 1).toBe(darkCount);
        // The top-left finder's first module lands at the quiet-zone offset.
        expect(path).toContain('M2 2h1v1h-1z');
    });

    it('sizes the viewBox to include the quiet zone on both sides', () => {
        const matrix = encodeQrCode('svg') as QrCodeMatrix;
        expect(qrCodeViewBoxSize(matrix, 2)).toBe(matrix.size + 4);
        expect(qrCodeViewBoxSize(matrix, 0)).toBe(matrix.size);
    });
});
