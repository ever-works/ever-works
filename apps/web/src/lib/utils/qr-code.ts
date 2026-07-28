/**
 * A small, dependency-free QR encoder — just enough of ISO/IEC 18004 to
 * turn a short enrollment payload into a scannable code.
 *
 * **Why hand-rolled.** The only thing the Fleet enroll flow needs is
 * "put this one short string on the screen so a phone or a node app can
 * read it without anyone retyping a 43-character secret". That is byte
 * mode, error-correction level L, versions 1–9 — a closed, testable
 * subset. Pulling a general-purpose QR library into the web bundle to
 * draw one square would be a worse trade, and everything here is pure:
 * no canvas, no DOM, no network, safe on the server and the client.
 *
 * **Scope (deliberate limits).**
 *   - Byte mode only (UTF-8). No numeric/alphanumeric/kanji compaction —
 *     they would shrink the code, not change what it can carry.
 *   - EC level L. The code is displayed on a screen, inches from the
 *     scanner; the higher levels buy damage tolerance nobody needs here
 *     and cost capacity.
 *   - Versions 1–9 (up to 230 bytes). Beyond v9 the block layout stops
 *     being uniform, and a payload that big does not belong in a QR on a
 *     settings page anyway. Oversize input returns `null` so the caller
 *     can fall back to the copy button rather than render a wrong code.
 *
 * The algorithm follows the reference structure (finder/alignment/timing
 * patterns, BCH-coded format + version info, zigzag data placement,
 * eight mask candidates scored by the four standard penalty rules).
 * `decodeQrCodeForTest` in the spec re-extracts the payload straight
 * from the finished matrix, so placement, masking and the Reed–Solomon
 * codewords are all verified end to end rather than eyeballed.
 */

/** Highest version this encoder emits (uniform block layout up to here). */
const MAX_VERSION = 9;

/** Total codewords per version, v1..v9. */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292];

/** EC codewords per block at level L, v1..v9. */
const ECC_PER_BLOCK_L = [7, 10, 15, 20, 26, 18, 20, 24, 30];

/** Number of EC blocks at level L, v1..v9. */
const NUM_BLOCKS_L = [1, 1, 1, 1, 1, 2, 2, 2, 2];

/** Format-info bits for error-correction level L. */
const EC_FORMAT_BITS_L = 1;

/** Penalty weights from the specification. */
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** A finished QR symbol: `modules[row][col]`, true = dark. */
export interface QrCodeMatrix {
    /** Modules per side (4 × version + 17). */
    size: number;
    modules: boolean[][];
}

/**
 * Encode `text` as a QR symbol, or return `null` when it does not fit
 * the supported range (empty, or larger than version 9 at level L).
 *
 * Returning null rather than throwing is deliberate: a QR is a
 * convenience next to a copy button, and a failure to draw one must
 * never take down the dialog that also shows the token.
 */
export function encodeQrCode(text: string): QrCodeMatrix | null {
    if (typeof text !== 'string' || text.length === 0) return null;

    const data = utf8Bytes(text);
    const version = pickVersion(data.length);
    if (version === null) return null;

    const codewords = buildCodewords(data, version);
    const size = version * 4 + 17;

    const modules: boolean[][] = createGrid(size, false);
    const isFunction: boolean[][] = createGrid(size, false);

    drawFunctionPatterns(modules, isFunction, version, size);
    drawCodewords(modules, isFunction, codewords, size);

    // Try every mask, keep the least-penalised one. The mask is not a
    // free choice: an unmasked symbol can contain large uniform areas or
    // accidental finder-like runs that scanners misread.
    let bestMask = 0;
    let bestPenalty = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 8; mask++) {
        applyMask(modules, isFunction, mask, size);
        drawFormatBits(modules, isFunction, mask, size);
        const penalty = penaltyScore(modules, size);
        if (penalty < bestPenalty) {
            bestPenalty = penalty;
            bestMask = mask;
        }
        // Masking is an XOR — applying it again restores the original.
        applyMask(modules, isFunction, mask, size);
    }
    applyMask(modules, isFunction, bestMask, size);
    drawFormatBits(modules, isFunction, bestMask, size);

    return { size, modules };
}

/**
 * Render a matrix as a single SVG `path` `d` attribute (one `M…h1v1h-1z`
 * per dark module), in a coordinate space of `size + 2 * quietZone`.
 *
 * One path for the whole symbol keeps the DOM to a single node — a v9
 * code is 2809 modules, and that many `<rect>`s is a real cost on a
 * settings page.
 */
export function qrCodeToSvgPath(matrix: QrCodeMatrix, quietZone = 2): string {
    const parts: string[] = [];
    for (let row = 0; row < matrix.size; row++) {
        for (let col = 0; col < matrix.size; col++) {
            if (matrix.modules[row][col]) {
                parts.push(`M${col + quietZone} ${row + quietZone}h1v1h-1z`);
            }
        }
    }
    return parts.join('');
}

/** Side length of the SVG viewBox for a matrix drawn with a quiet zone. */
export function qrCodeViewBoxSize(matrix: QrCodeMatrix, quietZone = 2): number {
    return matrix.size + quietZone * 2;
}

/**
 * The reserved (function-pattern) module map for a version — true where
 * a module belongs to a finder, separator, alignment, timing, format or
 * version area and therefore carries no data.
 *
 * Exported so the unit spec can decode a finished symbol back to its
 * payload. Everything else about the round trip (unmasking, the zigzag
 * read, de-interleaving, the Reed–Solomon syndrome check) is written
 * independently there, so the two halves genuinely cross-check.
 */
export function qrFunctionModuleMap(version: number): boolean[][] {
    const size = version * 4 + 17;
    const modules = createGrid(size, false);
    const isFunction = createGrid(size, false);
    drawFunctionPatterns(modules, isFunction, version, size);
    return isFunction;
}

/** Byte-mode payload capacity of a version at EC level L. */
export function qrByteCapacity(version: number): number {
    return byteCapacity(version);
}

/** Largest version this encoder emits. */
export const QR_MAX_VERSION = MAX_VERSION;

// ── encoding ────────────────────────────────────────────────────────

function utf8Bytes(text: string): number[] {
    // `TextEncoder` is available in every runtime this app targets
    // (browser, Node ≥22, edge) — no polyfill branch needed.
    return Array.from(new TextEncoder().encode(text));
}

/** Usable byte-mode payload for a version: data codewords minus the 12-bit header. */
function byteCapacity(version: number): number {
    return dataCodewordCount(version) - 2;
}

function dataCodewordCount(version: number): number {
    const index = version - 1;
    return TOTAL_CODEWORDS[index] - ECC_PER_BLOCK_L[index] * NUM_BLOCKS_L[index];
}

function pickVersion(byteLength: number): number | null {
    for (let version = 1; version <= MAX_VERSION; version++) {
        if (byteLength <= byteCapacity(version)) return version;
    }
    return null;
}

/**
 * Bit stream → padded data codewords → per-block Reed–Solomon → the
 * interleaved codeword sequence the matrix is filled with.
 */
function buildCodewords(data: number[], version: number): number[] {
    const bits: number[] = [];
    appendBits(bits, 0b0100, 4); // byte mode
    appendBits(bits, data.length, 8); // v1–v9 byte-mode length field
    for (const byte of data) appendBits(bits, byte, 8);

    const capacityBits = dataCodewordCount(version) * 8;
    // Terminator, then pad to a whole codeword.
    appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
    appendBits(bits, 0, (8 - (bits.length % 8)) % 8);

    const codewords: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
        codewords.push(byte);
    }
    // The two specified pad codewords, alternating.
    for (let pad = 0xec; codewords.length < dataCodewordCount(version); pad ^= 0xec ^ 0x11) {
        codewords.push(pad);
    }

    return addEccAndInterleave(codewords, version);
}

function appendBits(bits: number[], value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function addEccAndInterleave(data: number[], version: number): number[] {
    const index = version - 1;
    const numBlocks = NUM_BLOCKS_L[index];
    const blockEccLen = ECC_PER_BLOCK_L[index];
    const rawCodewords = TOTAL_CODEWORDS[index];
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);

    const divisor = rsComputeDivisor(blockEccLen);
    const blocks: number[][] = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
        const block = data.slice(k, k + dataLen);
        k += dataLen;
        const ecc = rsComputeRemainder(block, divisor);
        // Pad short blocks to a uniform length so the interleave below
        // is a plain column read; the padding slot is skipped, never
        // emitted.
        if (i < numShortBlocks) block.push(0);
        blocks.push(block.concat(ecc));
    }

    const result: number[] = [];
    for (let i = 0; i < blocks[0].length; i++) {
        for (let j = 0; j < blocks.length; j++) {
            if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
                result.push(blocks[j][i]);
            }
        }
    }
    return result;
}

// ── Reed–Solomon over GF(256), primitive polynomial 0x11D ───────────

function rsComputeDivisor(degree: number): number[] {
    const result = new Array<number>(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = rsMultiply(result[j], root);
            if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        root = rsMultiply(root, 0x02);
    }
    return result;
}

function rsComputeRemainder(data: readonly number[], divisor: readonly number[]): number[] {
    const result = new Array<number>(divisor.length).fill(0);
    for (const byte of data) {
        const factor = byte ^ (result.shift() as number);
        result.push(0);
        for (let i = 0; i < divisor.length; i++) {
            result[i] ^= rsMultiply(divisor[i], factor);
        }
    }
    return result;
}

function rsMultiply(x: number, y: number): number {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}

// ── matrix construction ─────────────────────────────────────────────

function createGrid(size: number, value: boolean): boolean[][] {
    return Array.from({ length: size }, () => new Array<boolean>(size).fill(value));
}

function drawFunctionPatterns(
    modules: boolean[][],
    isFunction: boolean[][],
    version: number,
    size: number,
): void {
    // Timing patterns.
    for (let i = 0; i < size; i++) {
        setFunction(modules, isFunction, 6, i, i % 2 === 0);
        setFunction(modules, isFunction, i, 6, i % 2 === 0);
    }

    // Finder patterns + their separators.
    drawFinder(modules, isFunction, 3, 3, size);
    drawFinder(modules, isFunction, 3, size - 4, size);
    drawFinder(modules, isFunction, size - 4, 3, size);

    // Alignment patterns, skipping the three that collide with finders.
    const positions = alignmentPositions(version, size);
    for (let i = 0; i < positions.length; i++) {
        for (let j = 0; j < positions.length; j++) {
            const isFinderCorner =
                (i === 0 && j === 0) ||
                (i === 0 && j === positions.length - 1) ||
                (i === positions.length - 1 && j === 0);
            if (!isFinderCorner) {
                drawAlignment(modules, isFunction, positions[i], positions[j]);
            }
        }
    }

    // Reserve the format areas (a dummy mask; the real bits are written
    // once the mask is chosen) and, from v7, the version areas.
    drawFormatBits(modules, isFunction, 0, size);
    if (version >= 7) drawVersionBits(modules, isFunction, version, size);
}

function drawFinder(
    modules: boolean[][],
    isFunction: boolean[][],
    centreRow: number,
    centreCol: number,
    size: number,
): void {
    for (let dr = -4; dr <= 4; dr++) {
        for (let dc = -4; dc <= 4; dc++) {
            const distance = Math.max(Math.abs(dr), Math.abs(dc));
            const row = centreRow + dr;
            const col = centreCol + dc;
            if (row >= 0 && row < size && col >= 0 && col < size) {
                setFunction(modules, isFunction, row, col, distance !== 2 && distance !== 4);
            }
        }
    }
}

function drawAlignment(
    modules: boolean[][],
    isFunction: boolean[][],
    centreRow: number,
    centreCol: number,
): void {
    for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
            setFunction(
                modules,
                isFunction,
                centreRow + dr,
                centreCol + dc,
                Math.max(Math.abs(dr), Math.abs(dc)) !== 1,
            );
        }
    }
}

function alignmentPositions(version: number, size: number): number[] {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
    return result;
}

/**
 * Write (or, on the reservation pass, merely claim) the 15 format bits:
 * EC level + mask, BCH(15,5)-coded and XORed with the specified mask
 * pattern so an all-zero format is never valid.
 */
function drawFormatBits(
    modules: boolean[][],
    isFunction: boolean[][],
    mask: number,
    size: number,
): void {
    const data = (EC_FORMAT_BITS_L << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = (((data << 10) | rem) ^ 0x5412) & 0x7fff;

    // Copy 1 — around the top-left finder.
    for (let i = 0; i <= 5; i++) setFunction(modules, isFunction, i, 8, getBit(bits, i));
    setFunction(modules, isFunction, 7, 8, getBit(bits, 6));
    setFunction(modules, isFunction, 8, 8, getBit(bits, 7));
    setFunction(modules, isFunction, 8, 7, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunction(modules, isFunction, 8, 14 - i, getBit(bits, i));

    // Copy 2 — split between the other two finders.
    for (let i = 0; i < 8; i++) setFunction(modules, isFunction, 8, size - 1 - i, getBit(bits, i));
    for (let i = 8; i < 15; i++)
        setFunction(modules, isFunction, size - 15 + i, 8, getBit(bits, i));
    // The always-dark module.
    setFunction(modules, isFunction, size - 8, 8, true);
}

/** BCH(18,6)-coded version number, mirrored near the two far finders. */
function drawVersionBits(
    modules: boolean[][],
    isFunction: boolean[][],
    version: number,
    size: number,
): void {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;

    for (let i = 0; i < 18; i++) {
        const bit = getBit(bits, i);
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFunction(modules, isFunction, b, a, bit);
        setFunction(modules, isFunction, a, b, bit);
    }
}

function setFunction(
    modules: boolean[][],
    isFunction: boolean[][],
    row: number,
    col: number,
    dark: boolean,
): void {
    modules[row][col] = dark;
    isFunction[row][col] = true;
}

function getBit(value: number, index: number): boolean {
    return ((value >>> index) & 1) !== 0;
}

/**
 * Fill the non-function modules with the codeword bits, in the standard
 * two-module-wide zigzag that runs right-to-left, skipping the vertical
 * timing column.
 */
function drawCodewords(
    modules: boolean[][],
    isFunction: boolean[][],
    codewords: readonly number[],
    size: number,
): void {
    let bitIndex = 0;
    const totalBits = codewords.length * 8;

    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5; // skip the timing column
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const col = right - j;
                const upward = ((right + 1) & 2) === 0;
                const row = upward ? size - 1 - vert : vert;
                if (!isFunction[row][col] && bitIndex < totalBits) {
                    modules[row][col] = getBit(codewords[bitIndex >>> 3], 7 - (bitIndex & 7));
                    bitIndex++;
                }
                // Remainder bits past the codewords stay light, which is
                // what the specification requires.
            }
        }
    }
}

/** XOR one of the eight mask patterns over the data modules only. */
function applyMask(
    modules: boolean[][],
    isFunction: boolean[][],
    mask: number,
    size: number,
): void {
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            if (isFunction[row][col]) continue;
            if (maskBit(mask, row, col)) modules[row][col] = !modules[row][col];
        }
    }
}

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

/** The four penalty rules that pick the least scanner-hostile mask. */
function penaltyScore(modules: boolean[][], size: number): number {
    let result = 0;

    // Rules 1 + 3, scanned in both directions.
    for (let row = 0; row < size; row++) {
        result += lineScore(modules[row], size);
        result += lineScore(
            Array.from({ length: size }, (_, r) => modules[r][row]),
            size,
        );
    }

    // Rule 2 — 2×2 blocks of one colour.
    for (let row = 0; row < size - 1; row++) {
        for (let col = 0; col < size - 1; col++) {
            const value = modules[row][col];
            if (
                value === modules[row][col + 1] &&
                value === modules[row + 1][col] &&
                value === modules[row + 1][col + 1]
            ) {
                result += PENALTY_N2;
            }
        }
    }

    // Rule 4 — deviation of the dark ratio from 50%.
    let dark = 0;
    for (const row of modules) for (const cell of row) if (cell) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += Math.max(k, 0) * PENALTY_N4;

    return result;
}

/** Rule 1 (runs of five or more) plus rule 3 (finder-like patterns). */
function lineScore(line: readonly boolean[], size: number): number {
    // Collapse the line into colour runs once; both rules read them.
    const runs: { length: number; dark: boolean }[] = [];
    let runColour = line[0];
    let runLength = 1;
    for (let i = 1; i < size; i++) {
        if (line[i] === runColour) {
            runLength++;
            continue;
        }
        runs.push({ length: runLength, dark: runColour });
        runColour = line[i];
        runLength = 1;
    }
    runs.push({ length: runLength, dark: runColour });

    let score = 0;

    // Rule 1 — every run of five or more same-coloured modules.
    for (const run of runs) {
        if (run.length >= 5) score += PENALTY_N1 + (run.length - 5);
    }

    // Rule 3 — a dark:light:dark:light:dark 1:1:3:1:1 core (the finder
    // signature) with at least 4n light modules on one side, which is
    // what makes a scanner mistake it for a finder pattern.
    for (let i = 0; i + 4 < runs.length; i++) {
        const [a, b, c, d, e] = runs.slice(i, i + 5);
        const unit = a.length;
        const isCore =
            a.dark &&
            unit > 0 &&
            b.length === unit &&
            c.length === unit * 3 &&
            d.length === unit &&
            e.length === unit;
        if (!isCore) continue;
        // The symbol edge counts as unlimited light (the quiet zone).
        const before = i === 0 ? Number.POSITIVE_INFINITY : runs[i - 1].length;
        const after = i + 5 >= runs.length ? Number.POSITIVE_INFINITY : runs[i + 5].length;
        if (before >= unit * 4 || after >= unit * 4) score += PENALTY_N3;
    }

    return score;
}
