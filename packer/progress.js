import {
    MultiBar,
    Presets,
} from 'cli-progress';

/**
 * @typedef {object} ProgressTask
 * @property {(description: string) => void} start Shows the item currently being processed.
 * @property {() => void} complete Marks the current item as complete.
 */

/**
 * @typedef {object} ProgressReporter
 * @property {(message: string) => void} log Writes an informational message.
 * @property {(message: string) => void} error Writes an error message.
 * @property {(label: string, total: number) => ProgressTask} createTask Creates a progress task.
 * @property {() => void} stop Stops any active terminal progress UI.
 */

/**
 * Creates progress reporting that uses interactive bars on TTY terminals and
 * simple line-oriented output when the progress stream is not a TTY.
 *
 * A MultiBar is used even though capture is sequential because it provides a
 * buffered `log()` API. That allows Playwright diagnostics to be printed while
 * bars are active without corrupting the terminal display.
 *
 * @param {NodeJS.WriteStream} [stream] Stream used for interactive progress.
 * @returns {ProgressReporter}
 */
export function createProgressReporter(stream = process.stderr) {
    const interactive = stream.isTTY === true;
    /** @type {MultiBar | null} */
    let multiBar = null;

    if (interactive) {
        multiBar = new MultiBar(
            {
                stream,
                barsize: 24,
                clearOnComplete: false,
                gracefulExit: true,
                hideCursor: true,
                autopadding: true,
            },
            Presets.shades_classic,
        );
    }

    /**
     * @param {string} message
     * @param {boolean} isError
     * @returns {void}
     */
    function writeMessage(message, isError) {
        if (multiBar?.isActive) {
            multiBar.log(`${message}\n`);
            return;
        }

        if (isError) {
            console.error(message);
        } else {
            console.log(message);
        }
    }

    return {
        log(message) {
            writeMessage(message, false);
        },

        error(message) {
            writeMessage(message, true);
        },

        createTask(label, total) {
            if (total <= 0) {
                return {
                    start() { },
                    complete() { },
                };
            }

            let value = 0;
            const countWidth = Math.max(3, String(total).length);

            if (!interactive || multiBar === null) {
                return {
                    start(description) {
                        console.log(
                            `[${label.padEnd(5)} ${String(value + 1).padStart(countWidth)}/${total}] `
                            + description,
                        );
                    },

                    complete() {
                        value++;
                    },
                };
            }

            const bar = multiBar.create(
                total,
                0,
                { filename: '' },
                {
                    format: `${label.padEnd(5)} [{bar}] {percentage}% | {value}/{total} | {filename}`,
                },
            );

            return {
                start(description) {
                    bar.update(value, { filename: description });
                },

                complete() {
                    value++;
                    bar.update(value);
                },
            };
        },

        stop() {
            if (!multiBar?.isActive) {
                return;
            }

            // Flush buffered diagnostics before the final bar render. cli-progress
            // does not flush MultiBar.log() messages from stop() itself.
            multiBar.update();
            multiBar.stop();
        },
    };
}
