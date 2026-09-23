/* eslint-disable @stylistic/indent-binary-ops */
import { parseArgs } from 'node:util';

const USAGE
	= 'Usage: node packer '
	+ '--csv <input Loc.csv file> '
	+ '--url <loc tool url> '
	+ '--out <output directory>';

/**
 * Error caused by invalid command-line usage.
 */
export class UsageError extends Error {
	/**
	 * @param {string} message Error message.
	 */
	constructor(message) {
		super(message);
		this.name = 'UsageError';
	}
}

/**
 * @typedef {object} CliArgs
 * @property {string} csv Input Loc.csv filename.
 * @property {string} url Localization-tool URL.
 * @property {string} out Output directory.
 * @property {boolean} makeFonts Whether font assets should be generated.
 */

/**
 * Parses and validates command-line arguments.
 *
 * @param {string[]} [argv] Arguments to parse.
 * @returns {CliArgs}
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
	const { values } = parseArgs({
		args: argv,
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
		!values.csv
		|| !values.url
		|| !values.out
	) {
		throw new UsageError(USAGE);
	}

	return {
		csv: values.csv,
		url: values.url,
		out: values.out,
		makeFonts: values.makeFonts,
	};
}
