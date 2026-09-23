import {
	readFile,
	rm,
} from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { webkit } from 'playwright';

import { makeZip } from './archive.js';
import {
	createRequestTracker,
	installBrowserLogging,
} from './browser.js';
import { capture } from './capture.js';
import { ensureDirectory } from './files.js';

const USAGE = 'Usage: node packer --csv <input Loc.csv file> --url <loc tool url> --out <output directory>';

/**
 * @typedef {object} CliArgs
 * @property {string} csv
 * @property {string} url
 * @property {string} out
 * @property {boolean} makeFonts
 */

/**
 * Parses and validates command-line arguments.
 *
 * @returns {CliArgs}
 */
function parseCliArgs() {
	const { values } = parseArgs({
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

	if (
		values.csv === undefined
		|| values.url === undefined
		|| values.out === undefined
	) {
		throw new Error(USAGE);
	}

	return {
		csv: values.csv,
		url: values.url,
		out: values.out,
		makeFonts: values.makeFonts,
	};
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

	let csv;

	try {
		csv = await readFile(csvFilename, 'utf8');
	}
	catch (error) {
		const fileError = /** @type {NodeJS.ErrnoException} */ (error);

		if (fileError.code === 'ENOENT') {
			throw new Error(
				`File not found: ${csvFilename}`,
				{ cause: error },
			);
		}

		throw error;
	}

	const code = path.parse(csvFilename).name;
	const tempDir = path.join(
		outputDir,
		`__tmp__${code}`,
	);

	await rm(tempDir, {
		recursive: true,
		force: true,
	});

	// Ensure the temporary tree exists even if the capture happens to produce
	// no files.
	await ensureDirectory(tempDir);

	const browser = await webkit.launch();

	/** @type {ReturnType<typeof createRequestTracker> | undefined} */
	let requestTracker;

	let language;

	try {
		const context = await browser.newContext();
		const page = await context.newPage();

		installBrowserLogging(context, page);

		requestTracker = createRequestTracker(context);

		console.log(`Opening page: ${args.url}`);
		await page.goto(args.url);

		language = await capture({
			page,
			waitForIdle: requestTracker.waitForIdle,
			scale: 1,
			makeFonts: args.makeFonts,
			outputDir: tempDir,
			csv,
		});
	}
	finally {
		requestTracker?.dispose();
		await browser.close();
	}

	const zipFilename = path.join(
		outputDir,
		`${language}.zip`,
	);

	console.log(`Zipping: ${zipFilename}`);

	await makeZip(
		tempDir,
		zipFilename,
	);

	// The temporary tree is no longer needed after a successful archive.
	await rm(tempDir, {
		recursive: true,
		force: true,
	});
}

const timerLabel = 'Finished in';

console.time(timerLabel);

try {
	await main();
}
catch (error) {
	console.error(
		error instanceof Error
			? error.message
			: error,
	);

	process.exitCode = 1;
}
finally {
	console.timeEnd(timerLabel);
}
