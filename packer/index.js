import {
	readFile,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Jimp } from 'jimp';
import { webkit } from 'playwright';
import { parseArgs } from 'node:util';
import JSZip from 'jszip';
import { ensureDirectory, resolveOutputPath, writeBinaryFile, writeTextFile } from './files.js';

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

/**
 * @typedef {object} PixelImage
 * @property {{data: Buffer}} bitmap
 * @property {number} width
 * @property {number} height
 * @property {(x?: number, y?: number, w?: number, h?: number) => Iterable<{
 *   x: number,
 *   y: number,
 *   idx: number,
 * }>} scanIterator
 * @property {(options: {
 *   x: number,
 *   y: number,
 *   w: number,
 *   h: number,
 * }) => unknown} crop
 */

/** @typedef {[number, number, number]} RGB */
/** @typedef {[number, number, number]} XYZ */
/** @typedef {[number, number, number]} LAB */

/**
 * @typedef {object} Rect
 * @property {number} x Left coordinate in pixels.
 * @property {number} y Top coordinate in pixels.
 * @property {number} width Rectangle width in pixels.
 * @property {number} height Rectangle height in pixels.
 */

/**
 * @typedef {object} QuantizeRect
 * @property {Rect} rect Region of the image that should be quantized.
 * @property {RGB[]} colors Palette permitted inside the region.
 */

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

/**
 * Converts the game's chroma-key colors into their intended alpha values.
 * Magenta (0xff00ff) becomes transparent and dark magenta (0x7f007f) becomes a
 * 50% black shadow.
 *
 * @param {PixelImage} image Image to modify in place.
 * @returns {void}
 */
function fixImageAlpha(image) {
	for (const { idx } of image.scanIterator()) {
		const r = image.bitmap.data[idx + 0];
		const g = image.bitmap.data[idx + 1];
		const b = image.bitmap.data[idx + 2];

		if (r === 255 && g === 0 && b === 255) {
			image.bitmap.data[idx + 3] = 0;
		}
		else if (r === 127 && g === 0 && b === 127) {
			image.bitmap.data[idx + 0] = 0;
			image.bitmap.data[idx + 1] = 0;
			image.bitmap.data[idx + 2] = 0;
			image.bitmap.data[idx + 3] = 127;
		}
	}
}

// http://stackoverflow.com/questions/15408522/rgb-to-xyz-and-lab-colours-conversion
/**
 * Converts an sRGB color to CIE L*a*b* through the D65 XYZ color space.
 * L*a*b* distances are used by the palette quantizer because they more
 * closely approximate perceptual color differences than raw RGB distances.
 *
 * @param {RGB} rgb RGB components in the range 0-255.
 * @returns {LAB}
 */
function RGBtoLAB(rgb) {
	// used for color quantization
	const xyz = RGBtoXYZ(rgb[0], rgb[1], rgb[2]);
	return XYZtoLAB(xyz[0], xyz[1], xyz[2]);
}

/**
 * Converts an sRGB color to CIE XYZ using a 2° observer and D65 illuminant.
 *
 * @param {number} R Red component in the range 0-255.
 * @param {number} G Green component in the range 0-255.
 * @param {number} B Blue component in the range 0-255.
 * @returns {XYZ}
 */
function RGBtoXYZ(R, G, B) {
	// Normalize sRGB components and linearize them before applying the D65 matrix.
	let r = R / 255;
	let g = G / 255;
	let b = B / 255;

	r = r > 0.04045 ? ((r + 0.055) / 1.055) ** 2.4 : r / 12.92;
	g = g > 0.04045 ? ((g + 0.055) / 1.055) ** 2.4 : g / 12.92;
	b = b > 0.04045 ? ((b + 0.055) / 1.055) ** 2.4 : b / 12.92;

	r *= 100;
	g *= 100;
	b *= 100;

	// Observer = 2°, illuminant = D65.
	const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
	const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
	const z = r * 0.0193 + g * 0.1192 + b * 0.9505;
	return [x, y, z];
}

/**
 * Converts a CIE XYZ color to CIE L*a*b* using the D65 reference white.
 *
 * @param {number} x CIE X component.
 * @param {number} y CIE Y component.
 * @param {number} z CIE Z component.
 * @returns {LAB}
 */
function XYZtoLAB(x, y, z) {
	const refX = 95.047;
	const refY = 100;
	const refZ = 108.883;

	let normalizedX = x / refX;
	let normalizedY = y / refY;
	let normalizedZ = z / refZ;

	normalizedX = normalizedX > 0.008856
		? normalizedX ** (1 / 3)
		: 7.787 * normalizedX + 16 / 116;
	normalizedY = normalizedY > 0.008856
		? normalizedY ** (1 / 3)
		: 7.787 * normalizedY + 16 / 116;
	normalizedZ = normalizedZ > 0.008856
		? normalizedZ ** (1 / 3)
		: 7.787 * normalizedZ + 16 / 116;

	const lightness = 116 * normalizedY - 16;
	const a = 500 * (normalizedX - normalizedY);
	const b = 200 * (normalizedY - normalizedZ);

	return [lightness, a, b];
}

/**
 * Quantizes a rectangular image region to the nearest color in a fixed palette.
 * Distance is measured in CIE L*a*b* space.
 *
 * @param {PixelImage} image Image to modify in place.
 * @param {Rect} rect Region to quantize.
 * @param {RGB[]} colors Allowed RGB palette.
 * @returns {void}
 */
function quantizeImage(image, rect, colors) {
	/** @type {LAB[]} */
	const palLab = colors.map(RGBtoLAB);

	for (const { idx } of image.scanIterator(
		rect.x,
		rect.y,
		rect.width,
		rect.height,
	)) {
		const r = image.bitmap.data[idx + 0];
		const g = image.bitmap.data[idx + 1];
		const b = image.bitmap.data[idx + 2];

		const rgbLab = RGBtoLAB([r, g, b]);

		let minDist = 0xFF_FF_FF;
		let minP = 0;

		for (let p = 0; p < palLab.length; p++) {
			const dist = Math.hypot(
				palLab[p][0] - rgbLab[0],
				palLab[p][1] - rgbLab[1],
				palLab[p][2] - rgbLab[2],
			);

			if (dist < minDist) {
				minDist = dist;
				minP = p;
			}
		}

		image.bitmap.data[idx + 0] = colors[minP][0];
		image.bitmap.data[idx + 1] = colors[minP][1];
		image.bitmap.data[idx + 2] = colors[minP][2];
	}
}

/**
 * Crops transparent borders while preserving every pixel whose alpha is greater
 * than 1. The image is modified in place.
 *
 * @param {PixelImage} image Image to crop.
 * @returns {void}
 */
function autocropImage(image) {
	// image.crop( x, y, w, h );
	let x0 = 10_000;
	let x1 = -10_000;
	let y0 = 10_000;
	let y1 = -10_000;

	for (const { x, y, idx } of image.scanIterator()) {
		const alpha = image.bitmap.data[idx + 3];

		if (alpha <= 1) {
			continue;
		}

		x0 = Math.min(x0, x);
		x1 = Math.max(x1, x);
		y0 = Math.min(y0, y);
		y1 = Math.max(y1, y);
	}

	if (x1 > x0 && y1 > y0) {
		image.crop({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
	}
}

/**
 * Scales a rectangle by a uniform factor.
 *
 * @param {Rect} rect Rectangle to scale.
 * @param {number} scale Uniform scale factor.
 * @returns {Rect}
 */
function scaleRect(rect, scale) {
	return { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale };
}

/**
 * Downscales an image by selecting the most common RGBA color from each `step`
 * by `step` source block. This preserves hard-edged pixel-art palettes better
 * than interpolation.
 *
 * @param {PixelImage} image Source image.
 * @param {number} step Number of source pixels represented by one output pixel
 * on each axis.
 * @returns Newly allocated downscaled image.
 */
function downscale(image, step) {
	const downscaledImage = new Jimp({
		width: image.width / step,
		height: image.height / step,
		color: 0x00_00_00_00,
	});

	for (let dy = 0; dy < downscaledImage.height; dy++) {
		for (let dx = 0; dx < downscaledImage.width; dx++) {
			/** @type {Map<number, number>} */
			const colorCounts = new Map();

			let bestColor = 0;
			let bestColorCount = 0;

			for (let sy = dy * step; sy < (dy + 1) * step; sy++) {
				for (let sx = dx * step; sx < (dx + 1) * step; sx++) {
					const si = (sy * image.width + sx) * 4;

					const r = image.bitmap.data[si + 0];
					const g = image.bitmap.data[si + 1];
					const b = image.bitmap.data[si + 2];
					const a = image.bitmap.data[si + 3];

					const p = (r << 24) | (g << 16) | (b << 8) | a;

					const count = (colorCounts.get(p) ?? 0) + 1;
					colorCounts.set(p, count);

					if (count > bestColorCount) {
						bestColor = p;
						bestColorCount = count;
					}
				}
			}

			const di = ((dy * downscaledImage.width) + dx) * 4;
			downscaledImage.bitmap.data[di + 0] = ((bestColor >> 24) & 0xFF);
			downscaledImage.bitmap.data[di + 1] = ((bestColor >> 16) & 0xFF);
			downscaledImage.bitmap.data[di + 2] = ((bestColor >> 8) & 0xFF);
			downscaledImage.bitmap.data[di + 3] = ((bestColor) & 0xFF);
		}
	}
	return downscaledImage;
}

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
 * Applies the complete post-processing pipeline to a captured image: optional
 * cropping, palette quantization, alpha-key conversion, and pixel-art downscaling.
 * The processed image replaces the file on disk.
 *
 * @param {string} filename Captured image path.
 * @param {number} width Intended logical width.
 * @param {number} height Intended logical height.
 * @param {QuantizeRect[]} quantizeRects Palette-constrained image regions.
 * @param {boolean} wantAutoCrop Whether transparent borders should be removed.
 * @returns {Promise<void>}
 */
async function finalizeImage(filename, width, height, quantizeRects, wantAutoCrop) {
	// Load the captured PNG before applying the post-processing pipeline.
	const image = await Jimp.read(filename);

	if (wantAutoCrop) {
		autocropImage(image);
	}

	// quantize areas if necessary
	for (let i = 0; i < quantizeRects.length; i++) {
		const scaledRect = scaleRect(quantizeRects[i].rect, image.width / width);
		quantizeImage(image, scaledRect, quantizeRects[i].colors);
	}

	// convert 0xff00ff -> transparent and 0x800080 -> shadow
	fixImageAlpha(image);

	if (width !== image.width || height !== image.height) {
		const downscaledImage = downscale(image, image.width / width);

		await downscaledImage.write(
			/** @type {`${string}.${string}`} */(filename),
		);

		return;
	}

	await image.write(
		/** @type {`${string}.${string}`} */(filename),
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
