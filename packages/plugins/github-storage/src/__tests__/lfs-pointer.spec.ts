import { describe, it, expect } from 'vitest';
import { formatPointer, parsePointer, ensureGitattributes, gitattributesLine } from '../lfs-pointer.js';

describe('lfs-pointer', () => {
	describe('formatPointer', () => {
		it('renders the canonical 3-line shape with a trailing newline', () => {
			const oid = 'a'.repeat(64);
			expect(formatPointer(oid, 42)).toBe(
				`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 42\n`
			);
		});

		it('rejects a non-hex / wrong-length oid', () => {
			expect(() => formatPointer('not-hex', 1)).toThrow(/Invalid LFS oid/);
			expect(() => formatPointer('a'.repeat(63), 1)).toThrow(/Invalid LFS oid/);
			expect(() => formatPointer('A'.repeat(64), 1)).toThrow(/Invalid LFS oid/); // uppercase
		});

		it('rejects negative / non-integer sizes', () => {
			const oid = '0'.repeat(64);
			expect(() => formatPointer(oid, -1)).toThrow(/Invalid LFS size/);
			expect(() => formatPointer(oid, 1.5)).toThrow(/Invalid LFS size/);
		});
	});

	describe('parsePointer', () => {
		it('round-trips with formatPointer', () => {
			const oid = '1'.repeat(64);
			const pointer = formatPointer(oid, 100);
			expect(parsePointer(pointer)).toEqual({ oid, size: 100 });
		});

		it('returns null for content that is not an LFS pointer', () => {
			expect(parsePointer('hello world')).toBeNull();
			expect(parsePointer('')).toBeNull();
			expect(parsePointer('version garbage\noid foo\nsize 1\n')).toBeNull();
		});

		it('tolerates CRLF and trailing whitespace', () => {
			const oid = '2'.repeat(64);
			const crlf = `version https://git-lfs.github.com/spec/v1\r\noid sha256:${oid}\r\nsize 17\r\n`;
			expect(parsePointer(crlf)).toEqual({ oid, size: 17 });
		});

		it('rejects malformed oid or size', () => {
			const oid = '3'.repeat(64);
			expect(parsePointer(`version https://git-lfs.github.com/spec/v1\noid sha256:short\nsize 1\n`)).toBeNull();
			expect(parsePointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize -3\n`)).toBeNull();
		});

		it('refuses to treat oversized blobs as candidate pointer files', () => {
			// guard rail — pointer files are tiny (~150 bytes). Anything
			// larger than 1 KiB cannot be a pointer.
			const big = 'version https://git-lfs.github.com/spec/v1\n' + 'x'.repeat(2048);
			expect(parsePointer(big)).toBeNull();
		});
	});

	describe('gitattributesLine', () => {
		it('emits the canonical LFS filter line for a path prefix', () => {
			expect(gitattributesLine('uploads')).toBe('uploads/** filter=lfs diff=lfs merge=lfs -text\n');
		});

		it('strips leading and trailing slashes', () => {
			expect(gitattributesLine('/foo/bar/')).toBe('foo/bar/** filter=lfs diff=lfs merge=lfs -text\n');
		});

		it('falls back to whole-repo tracking when the prefix is empty', () => {
			expect(gitattributesLine('')).toBe('* filter=lfs diff=lfs merge=lfs -text\n');
		});
	});

	describe('ensureGitattributes', () => {
		it('returns null when the line is already present', () => {
			expect(
				ensureGitattributes('# comment\nuploads/** filter=lfs diff=lfs merge=lfs -text\n', 'uploads')
			).toBeNull();
		});

		it('appends the line with a newline separator when the file is missing', () => {
			expect(ensureGitattributes(null, 'uploads')).toBe('uploads/** filter=lfs diff=lfs merge=lfs -text\n');
		});

		it('appends to existing content with proper newline handling', () => {
			expect(ensureGitattributes('*.txt text', 'media')).toBe(
				'*.txt text\nmedia/** filter=lfs diff=lfs merge=lfs -text\n'
			);
			expect(ensureGitattributes('*.txt text\n', 'media')).toBe(
				'*.txt text\nmedia/** filter=lfs diff=lfs merge=lfs -text\n'
			);
		});
	});
});
