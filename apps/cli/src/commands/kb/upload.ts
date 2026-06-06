import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { requireAuth } from '../auth';
import { getHttpClient } from '../../services/http-client';
import { handleCliError } from '../../utils/error';

/**
 * Response from `POST /api/works/:id/kb/uploads`. Mirrors the
 * agent-layer `KnowledgeBaseService.createUpload` return shape: an
 * upload row plus optional KB document (text passthrough only;
 * non-text MIMEs land with `extractionStatus=skipped`).
 */
interface KbUploadResponse {
    upload: {
        id: string;
        originalFilename: string;
        mimeType: string;
        fileSize: number;
        sha256: string;
        extractionStatus: string;
        extractedDocumentId: string | null;
    };
    document: {
        id: string;
        path: string;
        title: string;
    } | null;
}

/**
 * Minimal MIME sniffing — only covers extensions whose server-side
 * extractor route is text passthrough today (Phase 1B/b). Everything
 * else falls back to `application/octet-stream`; the server records
 * the MIME on the upload row and the operator can retry extraction
 * via the API once a matching extractor plugin is configured.
 */
function guessMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
        case '.md':
        case '.markdown':
            return 'text/markdown';
        case '.txt':
            return 'text/plain';
        case '.json':
            return 'application/json';
        case '.html':
        case '.htm':
            return 'text/html';
        case '.pdf':
            return 'application/pdf';
        case '.docx':
            return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        case '.xlsx':
            return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        default:
            return 'application/octet-stream';
    }
}

export const uploadCommand = new Command('upload')
    .description('Upload a source file into the Knowledge Base for a Work')
    .argument('<workId>', 'Work UUID')
    .argument('<filePath>', 'Local file to upload')
    .option('--title <title>', 'Override the resulting KB document title')
    .option('--class <class>', 'Target KB document class for the resulting document')
    .action(async (workId: string, filePath: string, options) => {
        try {
            await requireAuth();

            const absolute = path.resolve(filePath);
            if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
                console.error(
                    chalk.red(`Error: file not found or not a regular file: ${absolute}`),
                );
                process.exit(1);
            }

            const buffer = fs.readFileSync(absolute);
            const filename = path.basename(absolute);
            const mimeType = guessMimeType(filename);

            // Node 22 ships `FormData` + `Blob` globally; axios 1.x
            // serializes them natively with the correct multipart
            // boundary, so no `form-data` dep is needed (mirrors the
            // browser-side upload pattern used by the web client and
            // keeps the CLI bundle small).
            const form = new FormData();
            form.append('file', new Blob([buffer], { type: mimeType }), filename);
            if (options.title) form.append('title', String(options.title));
            if (options.class) form.append('targetClass', String(options.class));

            const http = getHttpClient();
            const spinner = ora(`Uploading ${filename} (${buffer.length} bytes)...`).start();

            try {
                const { data } = await http.post<KbUploadResponse>(
                    `/works/${encodeURIComponent(workId)}/kb/uploads`,
                    form,
                    // Let axios + the browser-compatible FormData set
                    // the multipart boundary. Overriding Content-Type
                    // explicitly would strip the boundary param and
                    // break the server-side multer parser.
                    { headers: { 'Content-Type': undefined as unknown as string } },
                );
                spinner.succeed('Upload accepted');

                console.log('');
                console.log(`${chalk.gray('Upload ID:')}   ${data.upload.id}`);
                console.log(`${chalk.gray('Filename:')}    ${data.upload.originalFilename}`);
                console.log(`${chalk.gray('MIME:')}        ${data.upload.mimeType}`);
                console.log(`${chalk.gray('Size:')}        ${data.upload.fileSize} bytes`);
                console.log(`${chalk.gray('SHA-256:')}     ${data.upload.sha256}`);
                console.log(
                    `${chalk.gray('Extraction:')}  ${data.upload.extractionStatus}` +
                        (data.upload.extractedDocumentId
                            ? chalk.gray(` → doc ${data.upload.extractedDocumentId}`)
                            : ''),
                );
                if (data.document) {
                    console.log('');
                    console.log(chalk.green('✓ Created KB document:'));
                    console.log(`  ${chalk.gray('ID:')}    ${data.document.id}`);
                    console.log(`  ${chalk.gray('Path:')}  ${data.document.path}`);
                    console.log(`  ${chalk.gray('Title:')} ${data.document.title}`);
                } else {
                    console.log(
                        chalk.yellow(
                            '\n⚠ No KB document was created — extractor route pending for this MIME.',
                        ),
                    );
                }
            } catch (error) {
                spinner.fail('Upload failed');
                throw error;
            }
        } catch (error) {
            handleCliError(error);
            process.exit(1);
        }
    });
