import {
	readFile,
	rm,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webkit } from 'playwright';
import { parseArgs } from 'node:util';
import { ensureDirectory, resolveOutputPath, writeBinaryFile, writeTextFile } from './files.js';
import { finalizeImage } from './image.js';
import { makeZip } from './archive.js';
import {
	createRequestTracker,
	installBrowserLogging,
} from './browser.js';

/**
 * @typedef {import('playwright').Page} Page
 * A Playwright page used to execute the localization capture code in the browser.
 */


/** @typedef {import('./image.js').QuantizeRect} QuantizeRect */
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
 * Fetches a binary resource from inside the browser page and converts it to a
 * Node.js Buffer. Fetching in the page preserves the same browser/session
 * context as the localization tool.
 *
 * @param {Page} page Playwright page hosting the localization tool.
 * @param {string} url Resource URL.
 * @returns {Promise<Buffer | null>} Resource contents, or `null` for a failed
 * HTTP response.
 */
async function loadBinaryAtUrl(page, url) {
	// Fetch inside the page so the request uses the browser's session and origin.
	const bytes = await page.evaluate(async (resourceUrl) => {
		const response = await fetch(resourceUrl);
		if (!response.ok) {
			return null;
		}

		const buffer = await response.arrayBuffer();
		return [...new Uint8Array(buffer)];
	}, url);

	return bytes === null ? null : Buffer.from(bytes);
}

// http://stackoverflow.com/questions/15408522/rgb-to-xyz-and-lab-colours-conversion

/**
 * Decodes a base64 data URL into a Node.js Buffer.
 *
 * @param {string} dataUrl Data URL containing base64-encoded contents.
 * @returns {Buffer} Decoded binary data.
 */
function decodeDataUrl(dataUrl) {
	// Everything before the first comma describes the payload. Everything after
	// it is the encoded data itself.
	const commaIndex = dataUrl.indexOf(',');

	if (commaIndex === -1) {
		throw new Error('Invalid data URL');
	}

	const metadata = dataUrl.slice(0, commaIndex);

	// The localization capture API currently emits base64 data URLs. Reject
	// other encodings instead of accidentally interpreting them as base64.
	if (!metadata.endsWith(';base64')) {
		throw new Error('Unsupported data URL encoding');
	}

	return Buffer.from(dataUrl.slice(commaIndex + 1), 'base64');
}

/**
 * Writes one data file produced by the browser-side capture API.
 *
 * Depending on `dataType`, the contents are either fetched through the browser,
 * decoded from a base64 data URL, or written directly as UTF-8 text.
 *
 * @param {Page} page Playwright page hosting the localization tool.
 * @param {string} dir Root directory of the generated language pack.
 * @param {CaptureDataFile} dataFile Capture-side file description.
 * @returns {Promise<void>}
 */
async function writeDataFile(page, dir, dataFile) {
	// Resolve the browser-provided path relative to the language-pack root and
	// ensure it cannot escape that directory.
	const filename = resolveOutputPath(dir, dataFile.filename);

	switch (dataFile.dataType) {
		case 'url': {
			// Fetch through the page rather than Node so the request shares the
			// page's origin, cookies, and browser session.
			const data = await loadBinaryAtUrl(page, dataFile.contents);

			if (data === null) {
				throw new Error(`Failed to load ${dataFile.contents}`);
			}

			await writeBinaryFile(filename, data);
			break;
		}

		case 'dataURL':
			// Embedded assets are already available locally as base64 data URLs.
			await writeBinaryFile(
				filename,
				decodeDataUrl(dataFile.contents),
			);
			break;

		default:
			// All remaining capture data is ordinary UTF-8 text.
			await writeTextFile(filename, dataFile.contents);
			break;
	}
}

/**
 * Captures one browser-side image and applies the game's image
 * post-processing pipeline.
 *
 * @param {Page} page Playwright page hosting the localization tool.
 * @param {number} scale Browser capture scale.
 * @param {string} dir Root directory of the generated language pack.
 * @param {CaptureImage} image Capture-side image description.
 * @returns {Promise<void>}
 */
async function captureImage(page, scale, dir, image) {
	// `image.filename` originates in browser-side capture data, so keep the
	// resulting path constrained to the language-pack directory.
	const filename = resolveOutputPath(dir, image.filename);

	await ensureDirectory(path.dirname(filename));

	// Hide everything except the requested capture element before taking the
	// screenshot. This changes shared page state, so image capture is kept
	// sequential rather than running multiple screenshots in parallel.
	await page.evaluate((imageId) => {
		const browser = /** @type {CaptureGlobal} */ (globalThis);
		browser.$.capture.isolate(imageId);
	}, image.id);

	// Capture the image at the requested scale with a transparent background.
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

	// Convert the raw screenshot into the format expected by the game:
	// quantization, alpha-key handling, optional cropping, and downscaling.
	await finalizeImage(
		filename,
		image.w,
		image.h,
		image.quantizeRects,
		image.wantAutoCrop,
	);
}

/**
 * Formats a compact progress prefix for console output.
 *
 * @param {string} name Operation label.
 * @param {number} i Zero-based item index.
 * @param {number} count Total number of items.
 * @returns {string}
 */
function progress(name, i, count) {
	let si = (i + 1).toString();
	while (si.length < 3) {
		si = ' ' + si;
	}
	const sc = count.toString();
	// while (sc.length < 3) sc = " " + sc;
	return '[' + name + ' ' + si + '/' + sc + ']';
}

/**
 * Drives the browser-side capture API, writes generated data files, captures
 * image elements, and post-processes them for the language pack.
 *
 * @param {Page} page Playwright page containing `$.capture`.
 * @param {() => Promise<void>} waitForIdle Waits for browser resources to finish loading.
 * @param {number} scale Browser capture scale.
 * @param {boolean} makeFonts Whether font assets should be generated.
 * @param {string} dir Temporary language-pack output directory.
 * @param {string} csv Contents of the input Loc.csv file.
 * @returns {Promise<string>} Language identifier reported by the capture tool.
 */
async function capture(
	page,
	waitForIdle,
	scale,
	makeFonts,
	dir,
	csv,
) {
	console.log('Preparing page');

	const load = /** @type {CaptureLoadResult} */ (
		await page.evaluate((csvContents) => {
			const browser = /** @type {CaptureGlobal} */ (globalThis);
			return browser.$.capture.load(csvContents);
		}, csv)
	);

	if (load.error !== undefined) {
		throw new Error(load.error);
	}

	await waitForIdle();

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

	console.log(`Language: ${begin.lang}`);
	console.log(
		`Packing ${begin.images.length} images `
		+ `and ${begin.dataFiles.length} data files`,
	);

	for (const [index, dataFile] of begin.dataFiles.entries()) {
		console.log(
			`${progress('Data   ', index, begin.dataFiles.length)} `
			+ dataFile.filename,
		);

		await writeDataFile(page, dir, dataFile);
	}

	for (const [index, image] of begin.images.entries()) {
		const flags = [
			image.quantizeRects.length > 0 ? 'PAL' : null,
			image.baked ? 'BAKED' : null,
		].filter(Boolean);

		console.log(
			`${progress('Image', index, begin.images.length)} `
			+ `${image.filename} (${image.w}x${image.h})`
			+ (flags.length > 0 ? ` ${flags.join(' ')}` : ''),
		);

		await captureImage(page, scale, dir, image);
	}

	return begin.lang;
}

process.on('unhandledRejection', (reason, p) => {
	console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

/**
 * Prints command-line usage and terminates the process with a failure status.
 *
 * @returns {never}
 */
function showUsage() {
	console.log('Usage: node packer --csv <input Loc.csv file> --url <loc tool url> --out <output directory>');
	process.exit(1);
}

/**
 * Reports a fatal error and terminates the process.
 *
 * @param {unknown} err Error or diagnostic value to print.
 * @returns {never}
 */
function abortWithError(err) {
	console.error(err);
	process.exit(1);
}

// Main
const timerId = 'Finished in';
console.time(timerId);

const {
	values: args,
} = parseArgs({
	options: {
		csv: {
			type: 'string',
		},
		url: {
			type: 'string',
		},
		out: {
			type: 'string',
		},
		makeFonts: {
			type: 'boolean',
			default: false,
		},
	},
	strict: true,
	allowPositionals: false,
});

if (args.csv === undefined || args.url === undefined || args.out === undefined) {
	showUsage();
}

const url = args.url;

const browser = await webkit.launch();
const context = await browser.newContext();
const page = await context.newPage();

installBrowserLogging(context, page);
const requestTracker = createRequestTracker(context);

console.log('Opening page: ' + url);
await page.goto(url);

console.log('Loading csv from ' + args.csv);
const code = path.parse(args.csv).name;

const dir = path.join(args.out, '__tmp__' + code);
await rm(dir, { recursive: true, force: true });

let csv;

try {
	csv = await readFile(args.csv, 'utf8');
}
catch (error) {
	const fileError = /** @type {NodeJS.ErrnoException} */ (error);
	if (fileError.code === 'ENOENT') {
		abortWithError('File not found: ' + args.csv);
	}

	throw error;
}

const lang = await capture(
	page,
	requestTracker.waitForIdle,
	1,
	args.makeFonts,
	dir,
	csv,
);
await browser.close();

const zipFilename = path.join(args.out, lang + '.zip');
console.log('Zipping: ' + zipFilename);
await makeZip(dir, zipFilename);

console.timeEnd(timerId);
