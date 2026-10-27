/**
 * The entries of a zip archive, read from its central directory WITHOUT extracting anything.
 *
 * The maintained extractor (`@electron-internal/extract-zip`) takes no per-entry callback, so the
 * plugin's own guards (zip-slip containment, symlink refusal) can no longer run inside the extraction.
 * They run over this list instead, BEFORE a single byte is written — which is stricter than the old
 * per-entry callback, where entries ahead of a refused one had already been written.
 *
 * Only what the guards need is read: the entry name and the external attributes (the unix mode lives
 * in their high 16 bits). Anything that does not parse as a well-formed central directory throws, so
 * a malformed archive is refused rather than extracted unchecked.
 */

export interface ZipCentralDirectoryEntry {
	/** The entry name as stored: UTF-8 when the archive says so (flag bit 11), else byte-for-byte latin1. */
	readonly fileName: string;
	/** The raw 32-bit external file attributes; the unix mode is the high 16 bits. */
	readonly externalFileAttributes: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_LENGTH = 22;
const EOCD_MAX_COMMENT = 0xffff;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_LENGTH = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const CENTRAL_HEADER_LENGTH = 46;
const UTF8_NAME_FLAG = 0x0800;

function fail(reason: string): never {
	throw new Error(`Refusing to extract a malformed zip archive: ${reason}`);
}

function findEndOfCentralDirectory(archive: Buffer): number {
	const lowest = Math.max(0, archive.length - EOCD_MIN_LENGTH - EOCD_MAX_COMMENT);
	for (let offset = archive.length - EOCD_MIN_LENGTH; offset >= lowest; offset--) {
		if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
	}
	return fail('no end-of-central-directory record');
}

function toSafeNumber(value: bigint, what: string): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${what} out of range`);
	return Number(value);
}

/** Every central-directory entry of `archive`, in stored order. Throws on anything malformed. */
export function readZipCentralDirectory(archive: Buffer): ZipCentralDirectoryEntry[] {
	if (archive.length < EOCD_MIN_LENGTH) fail('too short to be a zip archive');
	const eocd = findEndOfCentralDirectory(archive);

	let total = archive.readUInt16LE(eocd + 10);
	let size = archive.readUInt32LE(eocd + 12);
	let offset = archive.readUInt32LE(eocd + 16);

	if (total === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
		// Zip64: the real counts live in the zip64 end-of-central-directory record.
		const locator = eocd - ZIP64_LOCATOR_LENGTH;
		if (locator < 0 || archive.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) fail('zip64 locator missing');
		const record = toSafeNumber(archive.readBigUInt64LE(locator + 8), 'zip64 record offset');
		if (record + 56 > archive.length || archive.readUInt32LE(record) !== ZIP64_EOCD_SIGNATURE) {
			fail('zip64 end-of-central-directory record missing');
		}
		total = toSafeNumber(archive.readBigUInt64LE(record + 32), 'zip64 entry count');
		size = toSafeNumber(archive.readBigUInt64LE(record + 40), 'zip64 directory size');
		offset = toSafeNumber(archive.readBigUInt64LE(record + 48), 'zip64 directory offset');
	}

	if (offset + size > archive.length) fail('central directory extends past the end of the file');

	const entries: ZipCentralDirectoryEntry[] = [];
	let cursor = offset;
	for (let index = 0; index < total; index++) {
		if (cursor + CENTRAL_HEADER_LENGTH > archive.length) fail('truncated central directory');
		if (archive.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) fail('bad central directory header');
		const flags = archive.readUInt16LE(cursor + 8);
		const nameLength = archive.readUInt16LE(cursor + 28);
		const extraLength = archive.readUInt16LE(cursor + 30);
		const commentLength = archive.readUInt16LE(cursor + 32);
		const externalFileAttributes = archive.readUInt32LE(cursor + 38);
		const nameStart = cursor + CENTRAL_HEADER_LENGTH;
		const next = nameStart + nameLength + extraLength + commentLength;
		if (next > archive.length) fail('truncated central directory entry');
		// A non-UTF-8 name is decoded byte-for-byte: the bytes the guards care about (`.`, `/`, `\`,
		// a drive letter, NUL) are ASCII and read the same in every legacy zip code page.
		const nameBytes = archive.subarray(nameStart, nameStart + nameLength);
		const fileName = nameBytes.toString(flags & UTF8_NAME_FLAG ? 'utf8' : 'latin1');
		entries.push({ fileName, externalFileAttributes });
		cursor = next;
	}
	return entries;
}
