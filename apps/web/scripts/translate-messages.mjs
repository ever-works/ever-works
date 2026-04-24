#!/usr/bin/env node

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateObject } from 'ai';
import { z } from 'zod';

const DEFAULT_MODEL = 'x-ai/grok-4.1-fast';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_CHUNK_BYTES = 12000;
const DEFAULT_MAX_OUTPUT_TOKENS = 12000;
const DEFAULT_RETRIES = 3;
const DEFAULT_MODE = 'missing'; // full | missing
const SOURCE_LOCALE = 'en';

const LOCALE_NAMES = {
    ar: 'Arabic',
    bg: 'Bulgarian',
    de: 'German',
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    he: 'Hebrew',
    hi: 'Hindi',
    id: 'Indonesian',
    it: 'Italian',
    ja: 'Japanese',
    ko: 'Korean',
    nl: 'Dutch',
    pl: 'Polish',
    pt: 'Portuguese',
    ru: 'Russian',
    th: 'Thai',
    tr: 'Turkish',
    uk: 'Ukrainian',
    vi: 'Vietnamese',
    zh: 'Chinese',
};

async function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
        printHelp();
        return;
    }

    const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.PLUGIN_OPENROUTER_API_KEY;

    if (!apiKey) {
        throw new Error('Missing OPENROUTER_API_KEY or PLUGIN_OPENROUTER_API_KEY.');
    }

    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const webDir = path.resolve(scriptDir, '..');
    const messagesDir = path.join(webDir, 'messages');
    const sourcePath = path.join(messagesDir, `${SOURCE_LOCALE}.json`);

    const sourceMessages = readJson(await readFile(sourcePath, 'utf8'));
    const localeFiles = await getTargetLocaleFiles(
        messagesDir,
        options.locales,
        options.ignoredLocales,
    );

    console.log(
        [
            `Source: ${path.relative(process.cwd(), sourcePath)}`,
            `Locales: ${localeFiles.map((file) => path.basename(file, '.json')).join(', ')}`,
            options.ignoredLocales.length > 0
                ? `Ignored locales: ${options.ignoredLocales.join(', ')}`
                : null,
            `Model: ${options.model}`,
            `Translation mode: ${options.mode}`,
            `Chunk limit: ${options.chunkBytes} bytes`,
            options.dryRun ? 'Mode: dry-run' : 'Mode: write',
        ]
            .filter(Boolean)
            .join('\n'),
    );

    const provider = createOpenAICompatible({
        name: 'openrouter',
        apiKey,
        baseURL:
            process.env.OPENROUTER_BASE_URL ??
            process.env.PLUGIN_OPENROUTER_BASE_URL ??
            DEFAULT_BASE_URL,
        supportsStructuredOutputs: true,
        headers: buildOpenRouterHeaders(),
    });
    const model = provider.chatModel(options.model);

    for (const localeFile of localeFiles) {
        const locale = path.basename(localeFile, '.json');
        const language = LOCALE_NAMES[locale] ?? locale;
        const existingMessages = readJson(await readFile(localeFile, 'utf8'));
        const sourceSubset =
            options.mode === 'missing'
                ? getMissingTranslationTree(sourceMessages, existingMessages)
                : sourceMessages;
        const chunks = buildChunks(sourceSubset, [], options.chunkBytes);

        if (chunks.length === 0) {
            console.log(`\nSkipping ${locale} (${language}): no missing keys.`);
            continue;
        }

        const translatedMessages =
            options.mode === 'missing' ? structuredClone(existingMessages) : {};

        console.log(`\nTranslating ${locale} (${language})...`);
        console.log(`  Chunks: ${chunks.length}`);

        for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            const label = formatChunkLabel(chunk.path);
            console.log(`  [${index + 1}/${chunks.length}] ${label}`);

            const translatedValue = await translateChunkWithFallback({
                model,
                locale,
                language,
                chunk,
                chunkBytes: options.chunkBytes,
                retries: options.retries,
                maxOutputTokens: options.maxOutputTokens,
            });

            mergeChunk(translatedMessages, chunk.path, translatedValue);
        }

        const orderedMessages = orderLike(sourceMessages, translatedMessages);
        const output = `${JSON.stringify(orderedMessages, null, 4)}\n`;

        if (options.dryRun) {
            console.log(
                `  Dry run complete for ${locale}; skipped writing ${path.relative(process.cwd(), localeFile)}`,
            );
            continue;
        }

        await writeFile(localeFile, output, 'utf8');
        console.log(`  Wrote ${path.relative(process.cwd(), localeFile)}`);
    }
}

function parseArgs(argv) {
    const options = {
        chunkBytes: DEFAULT_CHUNK_BYTES,
        dryRun: false,
        help: false,
        ignoredLocales: [],
        locales: [],
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        model: DEFAULT_MODEL,
        mode: DEFAULT_MODE,
        retries: DEFAULT_RETRIES,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--help' || arg === '-h') {
            options.help = true;
            continue;
        }

        if (arg === '--dry-run') {
            options.dryRun = true;
            continue;
        }

        if (arg === '--mode') {
            const value = argv[index + 1];
            if (!value) {
                throw new Error('Missing value for --mode.');
            }

            options.mode = value;
            index += 1;
            continue;
        }

        if (arg.startsWith('--mode=')) {
            options.mode = arg.slice('--mode='.length);
            continue;
        }

        if (arg === '--locale') {
            const value = argv[index + 1];
            if (!value) {
                throw new Error('Missing value for --locale.');
            }

            options.locales.push(value);
            index += 1;
            continue;
        }

        if (arg.startsWith('--locale=')) {
            options.locales.push(arg.slice('--locale='.length));
            continue;
        }

        if (arg === '--locales') {
            const value = argv[index + 1];
            if (!value) {
                throw new Error('Missing value for --locales.');
            }

            options.locales.push(...parseCommaSeparated(value));
            index += 1;
            continue;
        }

        if (arg.startsWith('--locales=')) {
            options.locales.push(...parseCommaSeparated(arg.slice('--locales='.length)));
            continue;
        }

        if (arg === '--ignore-locale') {
            const value = argv[index + 1];
            if (!value) {
                throw new Error('Missing value for --ignore-locale.');
            }

            options.ignoredLocales.push(value);
            index += 1;
            continue;
        }

        if (arg.startsWith('--ignore-locale=')) {
            options.ignoredLocales.push(arg.slice('--ignore-locale='.length));
            continue;
        }

        if (arg === '--ignore-locales') {
            const value = argv[index + 1];
            if (!value) {
                throw new Error('Missing value for --ignore-locales.');
            }

            options.ignoredLocales.push(...parseCommaSeparated(value));
            index += 1;
            continue;
        }

        if (arg.startsWith('--ignore-locales=')) {
            options.ignoredLocales.push(
                ...parseCommaSeparated(arg.slice('--ignore-locales='.length)),
            );
            continue;
        }

        if (arg === '--chunk-bytes') {
            options.chunkBytes = parsePositiveInteger(argv[index + 1], '--chunk-bytes');
            index += 1;
            continue;
        }

        if (arg.startsWith('--chunk-bytes=')) {
            options.chunkBytes = parsePositiveInteger(
                arg.slice('--chunk-bytes='.length),
                '--chunk-bytes',
            );
            continue;
        }

        if (arg === '--max-output-tokens') {
            options.maxOutputTokens = parsePositiveInteger(argv[index + 1], '--max-output-tokens');
            index += 1;
            continue;
        }

        if (arg.startsWith('--max-output-tokens=')) {
            options.maxOutputTokens = parsePositiveInteger(
                arg.slice('--max-output-tokens='.length),
                '--max-output-tokens',
            );
            continue;
        }

        if (arg === '--retries') {
            options.retries = parsePositiveInteger(argv[index + 1], '--retries');
            index += 1;
            continue;
        }

        if (arg.startsWith('--retries=')) {
            options.retries = parsePositiveInteger(arg.slice('--retries='.length), '--retries');
            continue;
        }

        if (arg === '--model') {
            const value = argv[index + 1];
            if (!value) {
                throw new Error('Missing value for --model.');
            }

            options.model = value;
            index += 1;
            continue;
        }

        if (arg.startsWith('--model=')) {
            options.model = arg.slice('--model='.length);
            continue;
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    options.locales = [...new Set(options.locales.map((locale) => locale.trim()).filter(Boolean))];
    options.ignoredLocales = [
        ...new Set(options.ignoredLocales.map((locale) => locale.trim()).filter(Boolean)),
    ];

    if (!['full', 'missing'].includes(options.mode)) {
        throw new Error(`Invalid value for --mode: ${options.mode}. Use "full" or "missing".`);
    }

    return options;
}

function parseCommaSeparated(value) {
    return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function parsePositiveInteger(value, optionName) {
    if (!value) {
        throw new Error(`Missing value for ${optionName}.`);
    }

    const parsed = Number.parseInt(value, 10);

    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid value for ${optionName}: ${value}`);
    }

    return parsed;
}

function printHelp() {
    console.log(`Translate apps/web/messages/en.json into every existing locale file via OpenRouter.

Usage:
  pnpm --filter ever-works-web run translate:messages
  pnpm --filter ever-works-web run translate:messages --mode missing
  pnpm --filter ever-works-web run translate:messages --locale de
  pnpm --filter ever-works-web run translate:messages --ignore-locales ja,ko,zh
  pnpm --filter ever-works-web run translate:messages --locales de,fr --dry-run

Environment:
  OPENROUTER_API_KEY or PLUGIN_OPENROUTER_API_KEY   Required
  OPENROUTER_BASE_URL or PLUGIN_OPENROUTER_BASE_URL Optional, defaults to ${DEFAULT_BASE_URL}
  OPENROUTER_HTTP_REFERER                           Optional
  OPENROUTER_APP_NAME                               Optional

Options:
  --mode <full|missing>      Full retranslation or only fill keys missing from locale files.
  --locale <code>            Translate a single locale. Can be repeated.
  --locales <codes>          Comma-separated locale list.
  --ignore-locale <code>     Skip a locale. Can be repeated.
  --ignore-locales <codes>   Comma-separated locale skip list.
  --chunk-bytes <number>     Max serialized JSON bytes per translation chunk. Default: ${DEFAULT_CHUNK_BYTES}
  --max-output-tokens <n>    AI SDK maxOutputTokens value. Default: ${DEFAULT_MAX_OUTPUT_TOKENS}
  --retries <number>         Retries per chunk on parse/validation failure. Default: ${DEFAULT_RETRIES}
  --model <id>               Model id. Default: ${DEFAULT_MODEL}
  --dry-run                  Run translations without writing files.
  --help, -h                 Show this help.
`);
}

function buildOpenRouterHeaders() {
    const headers = {};
    const httpReferer = process.env.OPENROUTER_HTTP_REFERER;
    const appName = process.env.OPENROUTER_APP_NAME;

    if (httpReferer) {
        headers['HTTP-Referer'] = httpReferer;
    }

    if (appName) {
        headers['X-Title'] = appName;
    }

    return headers;
}

async function getTargetLocaleFiles(messagesDir, requestedLocales, ignoredLocales) {
    const files = (await readdir(messagesDir))
        .filter((file) => file.endsWith('.json') && file !== `${SOURCE_LOCALE}.json`)
        .sort();
    const ignoredLocaleSet = new Set(ignoredLocales);

    const fileByLocale = new Map(
        files.map((file) => [path.basename(file, '.json'), path.join(messagesDir, file)]),
    );
    const missingRequestedLocales = requestedLocales.filter((locale) => !fileByLocale.has(locale));
    const missingIgnoredLocales = ignoredLocales.filter((locale) => !fileByLocale.has(locale));

    if (missingRequestedLocales.length > 0) {
        throw new Error(`Unknown locale file(s): ${missingRequestedLocales.join(', ')}`);
    }

    if (missingIgnoredLocales.length > 0) {
        throw new Error(`Unknown ignored locale file(s): ${missingIgnoredLocales.join(', ')}`);
    }

    const targetLocales =
        requestedLocales.length === 0
            ? files.map((file) => path.basename(file, '.json'))
            : requestedLocales;

    const filteredLocales = targetLocales.filter((locale) => !ignoredLocaleSet.has(locale));

    if (filteredLocales.length === 0) {
        throw new Error('No locale files selected after applying ignored locales.');
    }

    return filteredLocales.map((locale) => fileByLocale.get(locale));
}

function buildChunks(value, pathSegments, maxBytes) {
    if (value === undefined) {
        return [];
    }

    if (jsonByteLength(value) <= maxBytes || !isPlainObject(value)) {
        return [{ path: pathSegments, value }];
    }

    const chunks = [];
    let batch = {};

    const flushBatch = () => {
        if (Object.keys(batch).length === 0) {
            return;
        }

        chunks.push({ path: pathSegments, value: batch });
        batch = {};
    };

    for (const [key, child] of Object.entries(value)) {
        const wrappedChild = { [key]: child };

        if (jsonByteLength(wrappedChild) > maxBytes && isPlainObject(child)) {
            flushBatch();
            chunks.push(...buildChunks(child, [...pathSegments, key], maxBytes));
            continue;
        }

        const candidate = { ...batch, [key]: child };
        if (Object.keys(batch).length > 0 && jsonByteLength(candidate) > maxBytes) {
            flushBatch();
        }

        batch[key] = child;
    }

    flushBatch();
    return chunks;
}

function getMissingTranslationTree(source, target) {
    if (target === undefined) {
        return source;
    }

    if (
        typeof source === 'string' ||
        typeof source === 'number' ||
        typeof source === 'boolean' ||
        source === null
    ) {
        return undefined;
    }

    if (Array.isArray(source)) {
        return Array.isArray(target) ? undefined : source;
    }

    if (!isPlainObject(source)) {
        return undefined;
    }

    if (!isPlainObject(target)) {
        return source;
    }

    const missingEntries = {};

    for (const [key, sourceValue] of Object.entries(source)) {
        const missingValue = getMissingTranslationTree(sourceValue, target[key]);
        if (missingValue !== undefined) {
            missingEntries[key] = missingValue;
        }
    }

    return Object.keys(missingEntries).length > 0 ? missingEntries : undefined;
}

async function translateChunk({ model, locale, language, chunk, retries, maxOutputTokens }) {
    let lastError;
    const schema = buildZodSchema(chunk.value);

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            const { object } = await generateObject({
                model,
                system: buildSystemPrompt(language),
                prompt: buildUserPrompt(locale, language, chunk.value, lastError),
                schema,
                schemaName: 'translated_messages_chunk',
                schemaDescription:
                    'Translated locale JSON chunk with the same structure and keys as the source.',
                maxOutputTokens,
            });

            const errors = [
                ...validateShape(chunk.value, object),
                ...validateMessageVariables(chunk.value, object),
            ];

            if (errors.length > 0) {
                throw new Error(errors.slice(0, 8).join('\n'));
            }

            return object;
        } catch (error) {
            lastError = formatErrorDetails(error);

            if (attempt === retries) {
                throw new Error(
                    `Failed to translate ${formatChunkLabel(chunk.path)} for ${locale}: ${lastError}`,
                );
            }

            console.warn(
                `    Retrying (${attempt + 1}/${retries}) after validation failure: ${lastError}`,
            );
        }
    }

    throw new Error(`Unreachable translation failure for ${locale}.`);
}

async function translateChunkWithFallback({
    model,
    locale,
    language,
    chunk,
    chunkBytes,
    retries,
    maxOutputTokens,
}) {
    try {
        return await translateChunk({
            model,
            locale,
            language,
            chunk,
            retries,
            maxOutputTokens,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const fallbackChunks = shouldSplitChunk(message) ? createFallbackChunks(chunk, chunkBytes) : [];

        if (fallbackChunks.length === 0) {
            throw error;
        }

        console.warn(
            `    Splitting ${formatChunkLabel(chunk.path)} into ${fallbackChunks.length} smaller chunks after provider failure`,
        );

        const mergedValue = {};

        for (const fallbackChunk of fallbackChunks) {
            const fallbackValue = await translateChunkWithFallback({
                model,
                locale,
                language,
                chunk: fallbackChunk,
                chunkBytes,
                retries,
                maxOutputTokens,
            });

            mergeChunk(mergedValue, getRelativeChunkPath(chunk.path, fallbackChunk.path), fallbackValue);
        }

        return mergedValue;
    }
}

function buildSystemPrompt(language) {
    return [
        'You are a professional software localization translator.',
        `Translate all English string values into ${language}.`,
        'Return only valid JSON.',
        'Preserve the JSON structure exactly: same keys, nesting, arrays, booleans, numbers, nulls, and string-only positions.',
        'Do not add keys, remove keys, rename keys, reorder list items, or wrap the answer in markdown.',
        'Preserve placeholders and formatting exactly, including variables like {email}, ICU message syntax, markdown, HTML tags, URLs, code identifiers, and newline escapes.',
        'Keep product and company names accurate unless they are normally localized in the target language.',
    ].join('\n');
}

function buildUserPrompt(locale, language, value, previousError) {
    const lines = [
        `Target locale: ${locale}`,
        `Target language: ${language}`,
        'Translate the following JSON value from English.',
        'If a string contains ICU MessageFormat syntax, translate only the human-readable text and keep variable names, categories, and brace structure intact.',
        'Output JSON only.',
        'JSON:',
        JSON.stringify(value, null, 2),
    ];

    if (previousError) {
        lines.unshift(
            `Previous attempt failed validation. Fix the issue and return corrected JSON only.\n${previousError}`,
        );
    }

    return lines.join('\n\n');
}

function shouldSplitChunk(errorMessage) {
    return (
        errorMessage.includes('Provider returned error') ||
        errorMessage.includes('rate limit') ||
        errorMessage.includes('context length') ||
        errorMessage.includes('token') ||
        errorMessage.includes('too large')
    );
}

function validateShape(source, target, pathLabel = 'root') {
    if (typeof source === 'string') {
        return typeof target === 'string' ? [] : [`${pathLabel}: expected string`];
    }

    if (typeof source === 'number' || typeof source === 'boolean' || source === null) {
        return Object.is(source, target)
            ? []
            : [`${pathLabel}: expected ${JSON.stringify(source)}`];
    }

    if (Array.isArray(source)) {
        if (!Array.isArray(target)) {
            return [`${pathLabel}: expected array`];
        }

        if (source.length !== target.length) {
            return [
                `${pathLabel}: expected array length ${source.length}, received ${target.length}`,
            ];
        }

        return source.flatMap((item, index) =>
            validateShape(item, target[index], `${pathLabel}[${index}]`),
        );
    }

    if (!isPlainObject(source) || !isPlainObject(target)) {
        return [`${pathLabel}: expected object`];
    }

    const sourceKeys = Object.keys(source);
    const targetKeys = Object.keys(target);
    const missingKeys = sourceKeys.filter((key) => !targetKeys.includes(key));
    const extraKeys = targetKeys.filter((key) => !sourceKeys.includes(key));
    const errors = [];

    if (missingKeys.length > 0) {
        errors.push(`${pathLabel}: missing keys ${missingKeys.join(', ')}`);
    }

    if (extraKeys.length > 0) {
        errors.push(`${pathLabel}: unexpected keys ${extraKeys.join(', ')}`);
    }

    for (const key of sourceKeys) {
        if (Object.hasOwn(target, key)) {
            errors.push(...validateShape(source[key], target[key], `${pathLabel}.${key}`));
        }
    }

    return errors;
}

function validateMessageVariables(source, target, pathLabel = 'root') {
    if (typeof source === 'string' && typeof target === 'string') {
        const sourceVariables = getMessageVariableSignatures(source);
        const targetVariables = getMessageVariableSignatures(target);

        return arraysEqual(sourceVariables, targetVariables)
            ? []
            : [
                  `${pathLabel}: variable mismatch. expected ${JSON.stringify(sourceVariables)} received ${JSON.stringify(
                      targetVariables,
                  )}`,
              ];
    }

    if (Array.isArray(source) && Array.isArray(target)) {
        return source.flatMap((item, index) =>
            validateMessageVariables(item, target[index], `${pathLabel}[${index}]`),
        );
    }

    if (isPlainObject(source) && isPlainObject(target)) {
        return Object.keys(source).flatMap((key) =>
            validateMessageVariables(source[key], target[key], `${pathLabel}.${key}`),
        );
    }

    return [];
}

function getMessageVariableSignatures(message) {
    const signatures = [];
    parseIcuMessage(message, 0, signatures);
    return signatures.sort();
}

function parseIcuMessage(message, startIndex, signatures, terminator = null) {
    let index = startIndex;

    while (index < message.length) {
        const char = message[index];

        if (terminator && char === terminator) {
            return index + 1;
        }

        if (char === "'" && isIcuQuoteStart(message, index)) {
            index = skipQuotedText(message, index);
            continue;
        }

        if (char === '{') {
            index = parseIcuArgument(message, index, signatures);
            continue;
        }

        index += 1;
    }

    if (terminator) {
        throw new Error(`Unclosed ICU block, expected "${terminator}"`);
    }

    return index;
}

function parseIcuArgument(message, openBraceIndex, signatures) {
    let index = openBraceIndex + 1;
    index = skipWhitespace(message, index);

    const argumentNameStart = index;
    while (index < message.length && /[a-zA-Z0-9_.-]/.test(message[index])) {
        index += 1;
    }

    const argumentName = message.slice(argumentNameStart, index).trim();
    if (!argumentName) {
        throw new Error(`Invalid ICU argument near index ${openBraceIndex}`);
    }

    index = skipWhitespace(message, index);

    if (message[index] === '}') {
        signatures.push(`var:${argumentName}`);
        return index + 1;
    }

    if (message[index] !== ',') {
        throw new Error(`Invalid ICU argument "${argumentName}" near index ${openBraceIndex}`);
    }

    index += 1;
    index = skipWhitespace(message, index);

    const formatTypeStart = index;
    while (index < message.length && /[a-zA-Z]/.test(message[index])) {
        index += 1;
    }

    const formatType = message.slice(formatTypeStart, index).trim();
    if (!formatType) {
        throw new Error(
            `Missing ICU format type for "${argumentName}" near index ${openBraceIndex}`,
        );
    }

    signatures.push(`${formatType}:${argumentName}`);
    index = skipWhitespace(message, index);

    if (message[index] === '}') {
        return index + 1;
    }

    if (message[index] !== ',') {
        throw new Error(`Invalid ICU format for "${argumentName}" near index ${openBraceIndex}`);
    }

    index += 1;

    if (formatType === 'plural' || formatType === 'selectordinal' || formatType === 'select') {
        return parseIcuOptions(message, index, signatures);
    }

    return skipUntilMatchingBrace(message, index);
}

function parseIcuOptions(message, startIndex, signatures) {
    let index = startIndex;

    while (index < message.length) {
        index = skipWhitespace(message, index);

        if (message[index] === '}') {
            return index + 1;
        }

        while (index < message.length && message[index] !== '{') {
            index += 1;
        }

        if (message[index] !== '{') {
            break;
        }

        index = parseIcuMessage(message, index + 1, signatures, '}');
    }

    throw new Error('Unclosed ICU options block');
}

function skipUntilMatchingBrace(message, startIndex) {
    let depth = 1;
    let index = startIndex;

    while (index < message.length) {
        const char = message[index];

        if (char === "'" && isIcuQuoteStart(message, index)) {
            index = skipQuotedText(message, index);
            continue;
        }

        if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return index + 1;
            }
        }

        index += 1;
    }

    throw new Error('Unclosed ICU argument');
}

function skipQuotedText(message, startIndex) {
    let index = startIndex + 1;

    while (index < message.length) {
        if (message[index] === "'") {
            if (message[index + 1] === "'") {
                index += 2;
                continue;
            }

            return index + 1;
        }

        index += 1;
    }

    return index;
}

function isIcuQuoteStart(message, index) {
    const next = message[index + 1];
    return next === "'" || next === '{' || next === '}' || next === '#';
}

function skipWhitespace(message, startIndex) {
    let index = startIndex;

    while (index < message.length && /\s/.test(message[index])) {
        index += 1;
    }

    return index;
}

function mergeChunk(target, pathSegments, value) {
    if (pathSegments.length === 0) {
        deepMergeInto(target, value);
        return;
    }

    let cursor = target;
    for (let index = 0; index < pathSegments.length - 1; index += 1) {
        const segment = pathSegments[index];
        if (!isPlainObject(cursor[segment])) {
            cursor[segment] = {};
        }

        cursor = cursor[segment];
    }

    const lastSegment = pathSegments[pathSegments.length - 1];

    if (isPlainObject(value) && isPlainObject(cursor[lastSegment])) {
        deepMergeInto(cursor[lastSegment], value);
        return;
    }

    cursor[lastSegment] = value;
}

function getRelativeChunkPath(parentPath, childPath) {
    return childPath.slice(parentPath.length);
}

function deepMergeInto(target, source) {
    for (const [key, value] of Object.entries(source)) {
        if (isPlainObject(value) && isPlainObject(target[key])) {
            deepMergeInto(target[key], value);
            continue;
        }

        target[key] = value;
    }
}

function orderLike(source, target) {
    if (
        typeof source === 'string' ||
        typeof source === 'number' ||
        typeof source === 'boolean' ||
        source === null
    ) {
        return target;
    }

    if (Array.isArray(source)) {
        const arrayTarget = Array.isArray(target) ? target : [];
        return source.map((item, index) => orderLike(item, arrayTarget[index]));
    }

    if (!isPlainObject(source)) {
        return target;
    }

    const objectTarget = isPlainObject(target) ? target : {};
    const ordered = {};

    for (const key of Object.keys(source)) {
        ordered[key] = orderLike(source[key], objectTarget[key]);
    }

    return ordered;
}

function formatChunkLabel(pathSegments) {
    return pathSegments.length === 0 ? 'root' : pathSegments.join('.');
}

function buildZodSchema(value) {
    if (typeof value === 'string') {
        return z.string();
    }

    if (typeof value === 'number') {
        return z.literal(value);
    }

    if (typeof value === 'boolean') {
        return z.literal(value);
    }

    if (value === null) {
        return z.null();
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return z.tuple([]);
        }

        return z.tuple(value.map((item) => buildZodSchema(item)));
    }

    const shape = {};

    for (const [key, child] of Object.entries(value)) {
        shape[key] = buildZodSchema(child);
    }

    return z.object(shape).strict();
}

function createFallbackChunks(chunk, chunkBytes) {
    if (!isPlainObject(chunk.value)) {
        return [];
    }

    const smallerChunks = buildChunks(chunk.value, chunk.path, Math.max(Math.floor(chunkBytes / 2), 2000));

    if (
        smallerChunks.length === 1 &&
        smallerChunks[0].path.length === chunk.path.length &&
        jsonByteLength(smallerChunks[0].value) === jsonByteLength(chunk.value)
    ) {
        return Object.entries(chunk.value).map(([key, value]) => ({
            path: [...chunk.path, key],
            value,
        }));
    }

    return smallerChunks;
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonByteLength(value) {
    return Buffer.byteLength(JSON.stringify(value));
}

function readJson(value) {
    return JSON.parse(value);
}

function arraysEqual(left, right) {
    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }

    return true;
}

function formatErrorDetails(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }

    const parts = new Set();

    if (error.message) {
        parts.add(error.message);
    }

    const cause = error.cause;
    if (cause instanceof Error && cause.message) {
        parts.add(cause.message);
    } else if (typeof cause === 'string' && cause) {
        parts.add(cause);
    }

    const knownFields = [
        error,
        cause && typeof cause === 'object' ? cause : null,
    ];

    for (const candidate of knownFields) {
        if (!candidate || typeof candidate !== 'object') {
            continue;
        }

        for (const key of ['responseBody', 'body', 'data', 'details']) {
            const value = candidate[key];
            if (value == null) {
                continue;
            }

            if (typeof value === 'string') {
                parts.add(value);
                continue;
            }

            try {
                parts.add(JSON.stringify(value));
            } catch {
                parts.add(String(value));
            }
        }

        if (typeof candidate.statusCode === 'number') {
            parts.add(`statusCode=${candidate.statusCode}`);
        }

        if (typeof candidate.responseHeaders === 'object' && candidate.responseHeaders !== null) {
            try {
                parts.add(`responseHeaders=${JSON.stringify(candidate.responseHeaders)}`);
            } catch {
                parts.add('responseHeaders=[unserializable]');
            }
        }
    }

    return [...parts].join(' | ');
}

main().catch((error) => {
    console.error(formatErrorDetails(error));
    process.exitCode = 1;
});
