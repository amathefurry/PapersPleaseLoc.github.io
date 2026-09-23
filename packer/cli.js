import { parseArgs } from 'node:util';

export const USAGE = [
    'Usage: node . --csv <input Loc.csv file> --url <loc tool url> --out <output directory> [--makeFonts]',
    '',
    'Options:',
    '  --csv <file>      Input localization CSV file',
    '  --url <url>       Localization-tool URL',
    '  --out <dir>       Output directory for the generated language pack',
    '  --makeFonts       Generate font assets',
    '  -h, --help        Show this help',
].join('\n');

/**
 * Error caused by invalid command-line usage.
 */
export class UsageError extends Error {
    /**
     * @param {string} message Error message.
     * @param {ErrorOptions} [options] Error options.
     */
    constructor(message, options) {
        super(message, options);
        this.name = 'UsageError';
    }
}

/**
 * @typedef {{
 *   help: true,
 * } | {
 *   help: false,
 *   csv: string,
 *   url: string,
 *   out: string,
 *   makeFonts: boolean,
 * }} CliArgs
 */

/**
 * Parses and validates command-line arguments.
 *
 * @param {string[]} [argv] Arguments to parse.
 * @returns {CliArgs}
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
    let values;

    try {
        ({ values } = parseArgs({
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
                help: {
                    type: 'boolean',
                    short: 'h',
                    default: false,
                },
            },
            strict: true,
            allowPositionals: false,
        }));
    } catch (error) {
        const message = error instanceof Error
            ? error.message
            : String(error);

        throw new UsageError(
            `${message}\n\n${USAGE}`,
            { cause: error },
        );
    }

    if (values.help) {
        return { help: true };
    }

    if (
        !values.csv
        || !values.url
        || !values.out
    ) {
        throw new UsageError(USAGE);
    }

    return {
        help: false,
        csv: values.csv,
        url: values.url,
        out: values.out,
        makeFonts: values.makeFonts ?? false,
    };
}
