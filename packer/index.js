import {
    readFile,
    rm,
} from 'node:fs/promises';
import path from 'node:path';
import { webkit } from 'playwright';

import { makeZip } from './archive.js';
import {
    createRequestTracker,
    installBrowserLogging,
} from './browser.js';
import { capture } from './capture.js';
import {
    parseCliArgs,
    UsageError,
} from './cli.js';
import { ensureDirectory } from './files.js';

/**
 * Reads the localization CSV and adds a clearer error while preserving the
 * original filesystem error as its cause.
 *
 * @param {string} filename CSV filename.
 * @returns {Promise<string>}
 */
async function readCsv(filename) {
    try {
        return await readFile(filename, 'utf8');
    } catch (error) {
        const fileError = /** @type {NodeJS.ErrnoException} */ (error);

        if (fileError.code === 'ENOENT') {
            throw new Error(
                `File not found: ${filename}`,
                { cause: error },
            );
        }

        throw error;
    }
}

/**
 * Runs the browser-backed capture stage and always releases its Playwright
 * resources.
 *
 * @param {object} options Capture-stage options.
 * @param {string} options.url Localization-tool URL.
 * @param {boolean} options.makeFonts Whether font assets should be generated.
 * @param {string} options.outputDir Temporary language-pack directory.
 * @param {string} options.csv Input Loc.csv contents.
 * @returns {Promise<string>} Captured language identifier.
 */
async function runCapture({
    url,
    makeFonts,
    outputDir,
    csv,
}) {
    const browser = await webkit.launch();

    /** @type {ReturnType<typeof createRequestTracker> | undefined} */
    let requestTracker;

    try {
        const context = await browser.newContext();
        const page = await context.newPage();

        installBrowserLogging(context, page);
        requestTracker = createRequestTracker(context);

        console.log(`Opening page: ${url}`);
        await page.goto(url);

        return await capture({
            page,
            waitForIdle: requestTracker.waitForIdle,
            scale: 1,
            makeFonts,
            outputDir,
            csv,
        });
    } finally {
        requestTracker?.dispose();
        await browser.close();
    }
}

/**
 * Runs the packer.
 *
 * @returns {Promise<void>}
 */
async function main() {
    const args = parseCliArgs();

    const csvFilename = path.resolve(args.csv);
    const outputDir = path.resolve(args.out);

    console.log(`Loading csv from ${csvFilename}`);
    const csv = await readCsv(csvFilename);

    const code = path.parse(csvFilename).name;
    const tempDir = path.join(
        outputDir,
        `__tmp__${code}`,
    );

    await rm(tempDir, {
        recursive: true,
        force: true,
    });
    await ensureDirectory(tempDir);

    const language = await runCapture({
        url: args.url,
        makeFonts: args.makeFonts,
        outputDir: tempDir,
        csv,
    });

    const zipFilename = path.join(
        outputDir,
        `${language}.zip`,
    );

    console.log(`Zipping: ${zipFilename}`);
    await makeZip(tempDir, zipFilename);

    await rm(tempDir, {
        recursive: true,
        force: true,
    });
}

const timerLabel = 'Finished in';

console.time(timerLabel);

try {
    await main();
} catch (error) {
    if (error instanceof UsageError) {
        console.error(error.message);
    } else {
        console.error(error);
    }

    process.exitCode = 1;
} finally {
    console.timeEnd(timerLabel);
}
