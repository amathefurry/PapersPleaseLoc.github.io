import path from 'node:path';
import {
    ensureDirectory,
    resolveOutputPath,
    writeBinaryFile,
    writeTextFile,
} from './files.js';
import { finalizeImage } from './image.js';

/** @typedef {import('playwright').Page} Page */
/** @typedef {import('./image.js').QuantizeRect} QuantizeRect */
/** @typedef {import('./progress.js').ProgressReporter} ProgressReporter */

/**
 * @typedef {object} CaptureDataFile
 * @property {string} filename Destination path relative to the language-pack root.
 * @property {string} dataType How `contents` should be interpreted.
 * @property {string} contents Text, a data URL, or a remote URL depending on `dataType`.
 */

/**
 * @typedef {object} CaptureImage
 * @property {string} id Browser-side identifier used by `$.capture.isolate`.
 * @property {string} filename Destination path relative to the language-pack root.
 * @property {number} w Logical output width.
 * @property {number} h Logical output height.
 * @property {QuantizeRect[]} quantizeRects Regions that require palette quantization.
 * @property {boolean} wantAutoCrop Whether transparent borders should be cropped.
 * @property {boolean} baked Whether the image comes from the game's baked resources.
 */

/**
 * @typedef {object} CaptureLoadResult
 * @property {string=} error Capture-side error message, when loading failed.
 */

/**
 * @typedef {object} CaptureBeginResult
 * @property {string=} error Capture-side error message, when initialization failed.
 * @property {string} lang Language identifier used for the resulting archive name.
 * @property {CaptureImage[]} images Images that must be rendered and post-processed.
 * @property {CaptureDataFile[]} dataFiles Additional files included in the language pack.
 */

/**
 * @typedef {object} CaptureApi
 * @property {(csv: string) => CaptureLoadResult} load
 * @property {(scale: number, makeFonts: boolean) => CaptureBeginResult} begin
 * @property {(imageId: string) => void} isolate
 */

/**
 * @typedef {typeof globalThis & {
 *   $: {
 *     capture: CaptureApi,
 *   },
 * }} CaptureGlobal
 */

/**
 * @typedef {object} CaptureOptions
 * @property {Page} page Playwright page containing `$.capture`.
 * @property {<T>(operation: () => Promise<T>) => Promise<T>} runAndWaitForIdle Waits for browser resources to finish loading.
 * @property {number} scale Browser capture scale.
 * @property {boolean} makeFonts Whether font assets should be generated.
 * @property {string} outputDir Temporary language-pack output directory.
 * @property {string} csv Contents of the input Loc.csv file.
 * @property {ProgressReporter} progress Shared progress/logging reporter.
 */

/**
 * Fetches a binary resource from inside the browser page.
 *
 * Fetching through the page preserves the localization tool's browser origin,
 * cookies, and session state.
 *
 * @param {Page} page Playwright page hosting the localization tool.
 * @param {string} url Resource URL.
 * @returns {Promise<Buffer | null>} Resource contents, or `null` when the HTTP
 * response is unsuccessful.
 */
async function loadBinaryAtUrl(page, url) {
    const bytes = await page.evaluate(async (resourceUrl) => {
        const response = await fetch(resourceUrl);

        return response.ok
            ? [...new Uint8Array(await response.arrayBuffer())]
            : null;
    }, url);

    return bytes === null
        ? null
        : Buffer.from(bytes);
}

/**
 * Decodes a base64-encoded data URL into a Node.js Buffer.
 *
 * @param {string} dataUrl Data URL containing base64-encoded contents.
 * @returns {Buffer} Decoded binary data.
 */
function decodeDataUrl(dataUrl) {
    const match = /^data:[^,];base64,(.*)$/s.exec(dataUrl);
    if (!match) {
        throw new Error('Unsupported data URL');
    }

    return Buffer.from(match[1], 'base64');
}

/**
 * Writes one data file produced by the browser-side capture API.
 *
 * @param {Page} page Playwright page hosting the localization tool.
 * @param {string} outputDir Root directory of the generated language pack.
 * @param {CaptureDataFile} dataFile Capture-side file description.
 * @returns {Promise<void>}
 */
async function writeDataFile(page, outputDir, dataFile) {
    // Browser-provided filenames are constrained to the language-pack root before
    // touching the filesystem.
    const filename = resolveOutputPath(
        outputDir,
        dataFile.filename,
    );

    switch (dataFile.dataType) {
        case 'url': {
            const data = await loadBinaryAtUrl(
                page,
                dataFile.contents,
            );

            if (data === null) {
                throw new Error(
                    `Failed to load ${dataFile.contents}`,
                );
            }

            await writeBinaryFile(filename, data);
            break;
        }

        case 'dataURL':
            await writeBinaryFile(
                filename,
                decodeDataUrl(dataFile.contents),
            );
            break;

        default:
            await writeTextFile(
                filename,
                dataFile.contents,
            );
            break;
    }
}

/**
 * Captures one browser-side image and applies the game's image
 * post-processing pipeline.
 *
 * @param {Page} page Playwright page hosting the localization tool.
 * @param {number} scale Browser capture scale.
 * @param {string} outputDir Root directory of the generated language pack.
 * @param {CaptureImage} image Capture-side image description.
 * @returns {Promise<void>}
 */
async function captureImage(
    page,
    scale,
    outputDir,
    image,
) {
    const filename = resolveOutputPath(
        outputDir,
        image.filename,
    );

    await ensureDirectory(
        path.dirname(filename),
    );

    // Isolation changes shared page state, so captures intentionally remain
    // sequential rather than running several screenshots in parallel.
    await page.evaluate((imageId) => {
        const browser = /** @type {CaptureGlobal} */ (globalThis);

        browser.$.capture.isolate(imageId);
    }, image.id);

    await page.screenshot({
        path: filename,
        clip: {
            x: 0,
            y: 0,
            width: scale * image.w,
            height: scale * image.h,
        },
        omitBackground: true,
    });

    await finalizeImage(
        filename,
        image.w,
        image.h,
        image.quantizeRects,
        image.wantAutoCrop,
    );
}

/**
 * Drives the browser-side capture API and writes the complete temporary
 * language-pack tree.
 *
 * @param {CaptureOptions} options Capture configuration.
 * @returns {Promise<string>} Language identifier reported by the capture tool.
 */
export async function capture({
    page,
    runAndWaitForIdle,
    scale,
    makeFonts,
    outputDir,
    csv,
    progress,
}) {
    progress.log('Preparing page');

    const load = /** @type {CaptureLoadResult} */ (
        await runAndWaitForIdle(
            () => page.evaluate((csvContents) => {
                const browser = /** @type {CaptureGlobal} */ (globalThis);

                return browser.$.capture.load(csvContents);
            }, csv),
        )
    );

    if (load.error !== undefined) {
        throw new Error(load.error);
    }

    const begin = /** @type {CaptureBeginResult} */ (
        await page.evaluate((args) => {
            const browser = /** @type {CaptureGlobal} */ (globalThis);

            return browser.$.capture.begin(
                args.scale,
                args.makeFonts,
            );
        }, { scale, makeFonts })
    );

    if (begin.error !== undefined) {
        throw new Error(begin.error);
    }

    progress.log(`Language: ${begin.lang}`);
    progress.log(
        `Packing ${begin.images.length} images `
        + `and ${begin.dataFiles.length} data files`,
    );

    const dataProgress = progress.createTask(
        'Data',
        begin.dataFiles.length,
    );
    const imageProgress = progress.createTask(
        'Image',
        begin.images.length,
    );

    for (const dataFile of begin.dataFiles) {
        dataProgress.start(dataFile.filename);
        await writeDataFile(page, outputDir, dataFile);
        dataProgress.complete();
    }

    for (const image of begin.images) {
        let flags = '';

        if (image.quantizeRects.length > 0) {
            flags += ' PAL';
        }

        if (image.baked) {
            flags += ' BAKED';
        }

        imageProgress.start(
            `${image.filename} (${image.w}x${image.h})${flags}`,
        );

        await captureImage(
            page,
            scale,
            outputDir,
            image,
        );
        imageProgress.complete();
    }

    return begin.lang;
}
