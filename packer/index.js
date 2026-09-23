import {
	readFile,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { webkit } from 'playwright';
import { parseArgs } from 'node:util';
import JSZip from 'jszip';
import { ensureDirectory, resolveOutputPath, writeBinaryFile, writeTextFile } from './files.js';
import { finalizeImage } from './image.js';

/**
 * @typedef {import('playwright').Page} Page
 * A Playwright page used to execute the localization capture code in the browser.
 */

/**
 * @typedef {import('playwright').BrowserContext} BrowserContext
 */

/**
 * @typedef {BrowserContext & {
 *   requestCount: number,
 *   requestsDone: () => Promise<void>,
 * }} TrackedBrowserContext
 * Browser context augmented with the request-tracking state installed by
 * {@link attachRequestTracker}.
 */

/** @typedef {InstanceType<typeof JSZip>} JSZipArchive */

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
 * Recursively adds files beneath `dir` to an archive. Archive entries always
 * use forward slashes, independent of the host operating system.
 *
 * @param {string} root Root directory used to derive relative archive paths.
 * @param {string} dir Directory currently being traversed.
 * @param {JSZipArchive} zip Archive being populated.
 * @returns {Promise<void>}
 */
async function addToZip(root, dir, zip) {
	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			await addToZip(root, fullPath, zip);
			continue;
		}

		const archivePath = path.relative(root, fullPath).split(path.sep).join('/');
		zip.file(archivePath, await readFile(fullPath));
	}
}

/**
 * Creates a ZIP archive containing the complete generated language-pack directory.
 *
 * @param {string} dir Directory to archive.
 * @param {string} outputFilename ZIP filename to create.
 * @returns {Promise<void>}
 */
async function makeZip(dir, outputFilename) {
	const zip = new JSZip();
	await addToZip(dir, dir, zip);

	const data = await zip.generateAsync({ type: 'nodebuffer' });
	await writeFile(outputFilename, data);
}

/**
 * Drives the browser-side capture API, writes generated data files, captures
 * image elements, and post-processes them for the language pack.
 *
 * @param {Page} page Playwright page containing `$.capture`.
 * @param {number} scale Browser capture scale.
 * @param {boolean} makeFonts Whether font assets should be generated.
 * @param {string} dir Temporary language-pack output directory.
 * @param {string} csv Contents of the input Loc.csv file.
 * @returns {Promise<string>} Language identifier reported by the capture tool.
 */
async function capture(page, scale, makeFonts, dir, csv) {
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

	const context = /** @type {TrackedBrowserContext} */ (page.context());

	await context.requestsDone();

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

/**
 * Adds lightweight request accounting to a Playwright browser context. The
 * resulting `requestsDone()` helper resolves once all tracked requests have
 * either completed or failed.
 *
 * @param {TrackedBrowserContext} context Browser context to augment.
 * @returns {void}
 */
function attachRequestTracker(context) {
	context.requestCount = 0;
	const requestTracker = {
		request() {
			context.requestCount++;
		},
		requestfailed() {
			context.requestCount--;
		},
		requestfinished() {
			context.requestCount--;
		},
	};

	context.on('request', requestTracker.request);
	context.on('requestfailed', requestTracker.requestfailed);
	context.on('requestfinished', requestTracker.requestfinished);

	context.requestsDone = async function () {
		while (context.requestCount !== 0) {
			await delay(10);
		}
	};
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
const context = /** @type {TrackedBrowserContext} */ (await browser.newContext());
const page = await context.newPage();

context.on('requestfailed', (request) => {
	const failure = request.failure();

	console.log(
		`url: ${request.url()}, `
		+ `errText: ${failure?.errorText ?? 'unknown'}, `
		+ `method: ${request.method()}`,
	);
});

page.on('pageerror', (error) => {
	console.log(`Page error: ${error}`);
});

attachRequestTracker(context);

page.on('console', (message) => {
	const messageText = message.text();
	const messageType = message.type().slice(0, 3).toUpperCase();
	const messageUrl = message.location() ? message.location().url : '';

	if (message.type() === 'error' && messageText.includes('404') && messageUrl.includes('/baked/')) {
		// ignore 404 errors on baked images
	}
	else if (messageUrl.length > 0) {
		console.log(`${messageType} ${messageText} (${messageUrl})`);
	}
	else {
		console.log(`${messageType} ${messageText}`);
	}
});

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

const lang = await capture(page, 1, args.makeFonts, dir, csv);
await browser.close();

const zipFilename = path.join(args.out, lang + '.zip');
console.log('Zipping: ' + zipFilename);
await makeZip(dir, zipFilename);

console.timeEnd(timerId);
