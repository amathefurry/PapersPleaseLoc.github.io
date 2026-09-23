import { setTimeout as delay } from 'node:timers/promises';

/**
 * @typedef {import('playwright').BrowserContext} BrowserContext
 * @typedef {import('playwright').Page} Page
 * @typedef {import('playwright').Request} Request
 * @typedef {import('./progress.js').ProgressReporter} ProgressReporter
 */

/**
 * Tracks browser requests without modifying the Playwright context.
 *
 * @param {BrowserContext} context Browser context whose requests should be tracked.
 * @returns {{
 *   runAndWaitForIdle: <T>(
 *     operation: () => Promise<T>,
 *     options?: {
 *       quietMs?: number,
 *       timeoutMs?: number,
 *     },
 *   ) => Promise<T>,
 *   dispose: () => void,
 * }}
 */
export function createRequestTracker(context) {
    /** @type {Map<Request, number>} */
    const pendingRequests = new Map();

    let nextRequestId = 0;

    /**
     * @param {Request} request
     * @returns {void}
     */
    const onRequest = (request) => {
        pendingRequests.set(
            request,
            nextRequestId++,
        );
    };

    /**
     * @param {Request} request
     * @returns {void}
     */
    const onRequestDone = (request) => {
        pendingRequests.delete(request);
    };

    context.on('request', onRequest);
    context.on('requestfinished', onRequestDone);
    context.on('requestfailed', onRequestDone);

    /**
     * Waits until all requests started at or after `firstRequestId`
     * have completed and the browser has remained quiet briefly.
     *
     * @param {number} firstRequestId
     * @param {{
     *   quietMs?: number,
     *   timeoutMs?: number,
     * }} [options]
     * @returns {Promise<void>}
     */
    async function waitForIdle(
        firstRequestId,
        {
            quietMs = 50,
            timeoutMs = 30_000,
        } = {},
    ) {
        const deadline = Date.now() + timeoutMs;
        let idleSince = null;

        while (Date.now() < deadline) {
            let hasPendingRequests = false;

            for (const requestId of pendingRequests.values()) {
                if (requestId >= firstRequestId) {
                    hasPendingRequests = true;
                    break;
                }
            }

            if (hasPendingRequests) {
                idleSince = null;
            } else {
                idleSince ??= Date.now();

                if (Date.now() - idleSince >= quietMs) {
                    return;
                }
            }

            await delay(10);
        }

        const pending = [...pendingRequests]
            .filter(([, requestId]) => requestId >= firstRequestId);

        const pendingUrls = pending
            .slice(0, 5)
            .map(([request]) => request.url());

        const details = pendingUrls.length > 0
            ? `\n${pendingUrls.map(url => `  - ${url}`).join('\n')}`
            : '';

        throw new Error(
            `Timed out waiting for ${pending.length} browser request`
            + `${pending.length === 1 ? '' : 's'} to finish.`
            + details,
        );
    }

    return {
        /**
         * Runs an operation and waits for requests started during or after that
         * operation to settle. Requests already pending before the operation are
         * intentionally ignored.
         *
         * @template T
         * @param {() => Promise<T>} operation
         * @param {{
         *   quietMs?: number,
         *   timeoutMs?: number,
         * }} [options]
         * @returns {Promise<T>}
         */
        async runAndWaitForIdle(
            operation,
            options,
        ) {
            const firstRequestId = nextRequestId;

            const result = await operation();

            await waitForIdle(
                firstRequestId,
                options,
            );

            return result;
        },

        /**
         * Removes the installed request listeners.
         *
         * @returns {void}
         */
        dispose() {
            context.off('request', onRequest);
            context.off('requestfinished', onRequestDone);
            context.off('requestfailed', onRequestDone);

            pendingRequests.clear();
        },
    };
}

/**
 * Installs diagnostic logging for browser failures, page errors, and console
 * messages.
 *
 * @param {BrowserContext} context Browser context used by the packer.
 * @param {Page} page Localization-tool page.
 * @param {ProgressReporter} progress Shared progress/logging reporter.
 * @returns {void}
 */
export function installBrowserLogging(context, page, progress) {
    context.on('requestfailed', (request) => {
        const failure = request.failure();

        progress.error(
            `Request failed: ${request.method()} ${request.url()}`
            + ` (${failure?.errorText ?? 'unknown error'})`,
        );
    });

    context.on('response', (response) => {
        if (response.ok()) {
            return;
        }

        progress.error(
            `HTTP ${response.status()} `
            + `${response.request().method()} ${response.url()}`,
        );
    });

    page.on('pageerror', (error) => {
        progress.error(`Page error: ${error.message}`);
    });

    page.on('console', (message) => {
        const text = message.text();
        const type = message.type();
        const url = message.location().url ?? '';

        if (
            type === 'error'
            && (
                text.includes('Failed to load resource')
                || (
                    text.includes('404')
                    && url.includes('/baked/')
                )
            )
        ) {
            return;
        }

        const prefix = type.slice(0, 3).toUpperCase();
        const output = url.length > 0
            ? `${prefix} ${text} (${url})`
            : `${prefix} ${text}`;

        if (type === 'error') {
            progress.error(output);
        } else {
            progress.log(output);
        }
    });
}
