import {
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Jimp } from 'jimp';
import { webkit } from 'playwright';
import { parseArgs } from 'node:util';
import JSZip from 'jszip';

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

/** @typedef {import('jimp').Jimp} JimpImage */
/** @typedef {InstanceType<typeof JSZip>} JSZipArchive */

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
 * Ensures that a directory exists, creating any missing parents as needed.
 *
 * @param {string} targetDir Directory path to create.
 * @returns {Promise<void>}
 */
async function guaranteeDir(targetDir) {
	await mkdir(targetDir, { recursive: true });
}

/**
 * Writes UTF-8 text after ensuring that the destination directory exists.
 *
 * @param {string} filename Destination filename.
 * @param {string} contents Text to write.
 * @returns {Promise<void>}
 */
async function writeUtf8File(filename, contents) {
	await guaranteeDir(path.dirname(filename));
	await writeFile(filename, contents, 'utf8');
}

/**
 * Writes binary data after ensuring that the destination directory exists.
 *
 * @param {string} filename Destination filename.
 * @param {Buffer} contents Binary payload.
 * @returns {Promise<void>}
 */
async function writeBinaryFile(filename, contents) {
	await guaranteeDir(path.dirname(filename));
	await writeFile(filename, contents);
}

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
	// https://github.com/puppeteer/puppeteer/issues/3722
	async function getBinaryAsString() {
		return page.evaluate((url) => {
			return new Promise(async (resolve) => {
				const reader = new FileReader();
				const response = await globalThis.fetch(url).then((response) => {
					return (response.ok) ? response : null;
				});
				if (response == null) {
					resolve(null);
				}
				else {
					const data = await response.blob();
					reader.readAsBinaryString(data);
					reader.addEventListener('load', () => resolve(reader.result));
					reader.onerror = () => reject('Error occurred while reading binary string');
				}
			});
		}, url);
	}
	const str = await getBinaryAsString();
	return (str == null) ? null : Buffer.from(str, 'binary');
}

/**
 * Converts the game's chroma-key colors into their intended alpha values.
 * Magenta (0xff00ff) becomes transparent and dark magenta (0x7f007f) becomes a
 * 50% black shadow.
 *
 * @param {JimpImage} image Image to modify in place.
 * @returns {Promise<void>}
 */
async function fixImageAlpha(image) {
	await image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, i) {
		const r = this.bitmap.data[i + 0];
		const g = this.bitmap.data[i + 1];
		const b = this.bitmap.data[i + 2];

		if (r == 255 && g == 0 && b == 255) {
			// fully transparent
			this.bitmap.data[i + 3] = 0;
		}
		else if (r == 127 && g == 0 && b == 127) {
			// 50% black shadow
			this.bitmap.data[i + 0] = 0;
			this.bitmap.data[i + 1] = 0;
			this.bitmap.data[i + 2] = 0;
			this.bitmap.data[i + 3] = 127;
		}
	});
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
	// used for color quantization
	var_R = Number.parseFloat(R / 255); // R from 0 to 255
	var_G = Number.parseFloat(G / 255); // G from 0 to 255
	var_B = Number.parseFloat(B / 255); // B from 0 to 255

	var_R = var_R > 0.04045 ? Math.pow((var_R + 0.055) / 1.055, 2.4) : var_R / 12.92;
	var_G = var_G > 0.04045 ? Math.pow((var_G + 0.055) / 1.055, 2.4) : var_G / 12.92;
	var_B = var_B > 0.04045 ? Math.pow((var_B + 0.055) / 1.055, 2.4) : var_B / 12.92;

	var_R = var_R * 100;
	var_G = var_G * 100;
	var_B = var_B * 100;

	// Observer. = 2°, Illuminant = D65
	X = var_R * 0.4124 + var_G * 0.3576 + var_B * 0.1805;
	Y = var_R * 0.2126 + var_G * 0.7152 + var_B * 0.0722;
	Z = var_R * 0.0193 + var_G * 0.1192 + var_B * 0.9505;
	return [X, Y, Z];
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
	// used for color quantization
	const ref_X = 95.047;
	const ref_Y = 100;
	const ref_Z = 108.883;

	var_X = x / ref_X; // ref_X =  95.047   Observer= 2°, Illuminant= D65
	var_Y = y / ref_Y; // ref_Y = 100.000
	var_Z = z / ref_Z; // ref_Z = 108.883

	var_X = var_X > 0.008856 ? Math.pow(var_X, (1 / 3)) : (7.787 * var_X) + (16 / 116);
	var_Y = var_Y > 0.008856 ? Math.pow(var_Y, (1 / 3)) : (7.787 * var_Y) + (16 / 116);
	var_Z = var_Z > 0.008856 ? Math.pow(var_Z, (1 / 3)) : (7.787 * var_Z) + (16 / 116);

	CIE_L = (116 * var_Y) - 16;
	CIE_a = 500 * (var_X - var_Y);
	CIE_b = 200 * (var_Y - var_Z);

	return [CIE_L, CIE_a, CIE_b];
}

/**
 * Quantizes a rectangular image region to the nearest color in a fixed palette.
 * Distance is measured in CIE L*a*b* space.
 *
 * @param {JimpImage} image Image to modify in place.
 * @param {Rect} rect Region to quantize.
 * @param {RGB[]} colors Allowed RGB palette.
 * @returns {Promise<void>}
 */
async function quantizeImage(image, rect, colors) {
	// quantize pixels in rect to available colors
	const palLab = [];
	for (let i = 0; i < colors.length; i++) {
		palLab.push(RGBtoLAB(colors[i]));
	}
	await image.scan(rect.x, rect.y, rect.width, rect.height, function (x, y, i) {
		const r = this.bitmap.data[i + 0];
		const g = this.bitmap.data[i + 1];
		const b = this.bitmap.data[i + 2];
		const rgbLab = RGBtoLAB([r, g, b]);

		let minDist = 0xFF_FF_FF;
		let minP = 0;
		for (let p = 0; p < palLab.length; p++) {
			const dist = Math.sqrt(
				(palLab[p][0] - rgbLab[0]) * (palLab[p][0] - rgbLab[0])
				+ (palLab[p][1] - rgbLab[1]) * (palLab[p][1] - rgbLab[1])
				+ (palLab[p][2] - rgbLab[2]) * (palLab[p][2] - rgbLab[2]),
			);
			if (dist < minDist) {
				minDist = dist;
				minP = p;
			}
		}
		this.bitmap.data[i + 0] = colors[minP][0];
		this.bitmap.data[i + 1] = colors[minP][1];
		this.bitmap.data[i + 2] = colors[minP][2];
	});
}

/**
 * Crops transparent borders while preserving every pixel whose alpha is greater
 * than 1. The image is modified in place.
 *
 * @param {JimpImage} image Image to crop.
 * @returns {void}
 */
function autocropImage(image) {
	// image.crop( x, y, w, h );
	let x0 = 10_000;
	let x1 = -10_000;
	let y0 = 10_000;
	let y1 = -10_000;

	image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, i) {
		const a = this.bitmap.data[i + 3];
		if (!(a > 1)) {
			return;
		}

		x0 = Math.min(x0, x);
		x1 = Math.max(x1, x);
		y0 = Math.min(y0, y);
		y1 = Math.max(y1, y);
	});

	if (x1 > x0 && y1 > y0) { image.crop(x0, y0, x1 - x0 + 1, y1 - y0 + 1); }
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
 * @param {JimpImage} image Source image.
 * @param {number} step Number of source pixels represented by one output pixel
 * on each axis.
 * @returns {JimpImage} Newly allocated downscaled image.
 */
function downscale(image, step) {
	const downscaledImage = new Jimp(image.bitmap.width / step, image.bitmap.height / step, () => {
		// this image is 256 x 256, every pixel is set to 0x00000000
	});

	for (let dy = 0; dy < downscaledImage.bitmap.height; dy++) {
		for (let dx = 0; dx < downscaledImage.bitmap.width; dx++) {
			const colorCounts = {};
			let bestColor = 0;
			let bestColorCount = 0;
			for (let sy = dy * step; sy < (dy + 1) * step; sy++) {
				for (let sx = dx * step; sx < (dx + 1) * step; sx++) {
					const si = (sy * image.bitmap.width + sx) * 4;
					const r = image.bitmap.data[si + 0];
					const g = image.bitmap.data[si + 1];
					const b = image.bitmap.data[si + 2];
					const a = image.bitmap.data[si + 3];
					const p = (r << 24) | (g << 16) | (b << 8) | a;
					if (p in colorCounts) { colorCounts[p] += 1; }
					else { colorCounts[p] = 1; }
					if (colorCounts[p] > bestColorCount) {
						bestColor = p;
						bestColorCount = colorCounts[p];
					}
				}
			}
			const di = ((dy * downscaledImage.bitmap.width) + dx) * 4;
			downscaledImage.bitmap.data[di + 0] = ((bestColor >> 24) & 0xFF);
			downscaledImage.bitmap.data[di + 1] = ((bestColor >> 16) & 0xFF);
			downscaledImage.bitmap.data[di + 2] = ((bestColor >> 8) & 0xFF);
			downscaledImage.bitmap.data[di + 3] = ((bestColor) & 0xFF);
		}
	}
	return downscaledImage;
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
	// load and shrink
	let image = await new Promise(function (resolve, reject) {
		Jimp.read(filename, function (err, img) {
			if (err) { reject(err); }

			if (wantAutoCrop) {
				autocropImage(img);
			}

			if (width != img.bitmap.width || height != img.bitmap.height) {
				// img = img.resize(width, height, Jimp.RESIZE_NEAREST_NEIGHBOR);
			}

			resolve(img);
		});
	});

	// quantize areas if necessary
	for (let i = 0; i < quantizeRects.length; i++) {
		const scaledRect = scaleRect(quantizeRects[i].rect, image.bitmap.width / width);
		await quantizeImage(image, scaledRect, quantizeRects[i].colors);
	}

	// convert 0xff00ff -> transparent and 0x800080 -> shadow
	await fixImageAlpha(image);

	if (width != image.width || height != image.height) {
		image = await downscale(image, image.bitmap.width / width);
	}

	// overwrite original file
	await image.write(filename);
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
	while (si.length < 3) { si = ' ' + si; }
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
 * Drives the browser-side capture API, writes all generated data files, captures
 * image elements, and post-processes those images for the final language pack.
 *
 * @param {Page} page Playwright page containing `$.capture`.
 * @param {number} scale Browser capture scale.
 * @param {boolean} makeFonts Whether the capture tool should generate font assets.
 * @param {string} dir Output directory for the temporary language-pack tree.
 * @param {string} csv Contents of the input Loc.csv file.
 * @returns {Promise<string>} Language identifier reported by the capture tool.
 */
async function capture(page, scale, makeFonts, dir, csv) {
	console.log('Preparing page');

	// begin capture with the input Loc.csv
	const load = await page.evaluate(function (a) {
		return $.capture.load(a);
	}, csv);

	if (load.error !== undefined) { abortWithError(load.error); }

	// wait for all image/resource requests for finish loading
	await page.context().requestsDone();

	const begin = await page.evaluate(await function (args) {
		return $.capture.begin(args.scale, args.makeFonts);
	}, { scale, makeFonts });

	if (begin.error !== undefined) { abortWithError(begin.error); }

	const images = begin.images;
	const dataFiles = begin.dataFiles;

	console.log('Language: ' + begin.lang);
	console.log('Packing ' + images.length + ' images and ' + dataFiles.length + ' data files');

	// write out all data files
	for (var i = 0; i < dataFiles.length; i++) {
		const dataFile = dataFiles[i];
		console.log(progress('Data   ', i, dataFiles.length) + ' ' + dataFile.filename);
		if (dataFile.dataType == 'url') {
			const data = await loadBinaryAtUrl(page, dataFile.contents);
			if (data != null) { await writeBinaryFile(path.join(dir, dataFile.filename), data); }
		}
		else if (dataFile.dataType == 'dataURL') {
			const buffer = Buffer.from(dataFile.contents.split(',', 2)[1], 'base64');
			await writeBinaryFile(path.join(dir, dataFile.filename), buffer);
		}
		else {
			await writeUtf8File(path.join(dir, dataFile.filename), dataFile.contents);
		}
	}

	// write out all image files
	for (var i = 0; i < images.length; i++) {
		const image = images[i];
		// if (image.id != "ApartmentClass") continue;
		// if (image.id != "BulletinPagesNote") continue;
		// if (image.id != "BulletinInnerTouchTut") continue;
		// if (image.id != "ApartmentClass" && !image.id.startsWith("AccessPermit")) continue;

		console.log(progress('Image', i, images.length) + ' ' + image.filename + ' (' + image.w + 'x' + image.h + ')' + (image.quantizeRects.length ? ' PAL' : '') + (image.baked ? ' BAKED' : ''));

		const filename = path.join(dir, image.filename);
		await guaranteeDir(path.dirname(filename));

		// isolate element and capture page
		await page.evaluate(function (imageId) {
			$.capture.isolate(imageId);
		}, image.id);

		const options = {
			path: filename,
			clip: { x: 0, y: 0, width: scale * image.w, height: scale * image.h },
			omitBackground: true,
		};

		await page.screenshot(options);

		await finalizeImage(filename, image.w, image.h, image.quantizeRects, image.wantAutoCrop);
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
		request() { context.requestCount++; }, // console.log(`request (${page.requestCount})`); },
		requestfailed() { context.requestCount--; }, // console.log(`requestfailed (${page.requestCount})`); },
		requestfinished() { context.requestCount--; }, // console.log(`requestfinished (${page.requestCount})`); },
	};

	context.on('request', requestTracker.request);
	context.on('requestfailed', requestTracker.requestfailed);
	context.on('requestfinished', requestTracker.requestfinished);

	context.requestsDone = function () {
		return new Promise(function (resolve) {
			function f() {
				if (context.requestCount == 0) { resolve(); }
				else { setTimeout(f, 10); }
			}
			f();
		});
	};
}

// Main
(async function () {
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

	if (args.csv == null || args.url == null || args.out == null) { showUsage(); }

	const url = args.url;

	const browser = await webkit.launch();
	const context = /** @type {TrackedBrowserContext} */ await browser.newContext();

	context.on('requestfailed', (request) => {
		console.log(`url: ${request.url()}, errText: ${request.failure().errorText}, method: ${request.method()}`);
	});
	context.on('pageerror', (err) => {
		console.log(`Page error: ${err.toString()}`);
	});

	attachRequestTracker(context);

	const page = await context.newPage();

	page.on('console', (message) => {
		const messageText = message.text();
		const messageType = message.type().slice(0, 3).toUpperCase();
		const messageUrl = message.location() ? message.location().url : '';

		if (message.type() == 'error' && messageText.includes('404') && messageUrl.includes('/baked/')) {
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

	console.log('Loading csv from ' + args.csv);
	const code = path.parse(args.csv).name;

	const dir = path.join(args.out, '__tmp__' + code);
	await rm(dir, { recursive: true, force: true });

	let csv;

	try {
		csv = await readFile(args.csv, 'utf8');
	}
	catch (error) {
		if (error.code === 'ENOENT') {
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
})();
