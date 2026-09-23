import { setTimeout as delay } from 'node:timers/promises';

/**
 * @typedef {import('playwright').BrowserContext} BrowserContext
 * @typedef {import('playwright').Page} Page
 * @typedef {import('playwright').Request} Request
 * @typedef {import('./progress.js').ProgressReporter} ProgressReporter
 */

/**
 * Tracks outstanding browser requests without modifying the Playwright
 * BrowserContext object.
 *
 * @param {BrowserContext} context Browser context whose requests should be tracked.
 * @returns {{
 *   waitForIdle: (options?: {
 *     quietMs?: number,
 *     timeoutMs?: number,
 *   }) => Promise<void>,
 *   dispose: () => void,
 * }}
 */
export function createRequestTracker(context) {
    /** @type {Set<Request>} */
    const pendingRequests = new Set();

    /** @param {Request} request */
    const onRequest = (request) => {
        pendingRequests.add(request);
    };

    /** @param {Request} request */
    const onRequestDone = (request) => {
        pendingRequests.delete(request);
    };

    context.on('request', onRequest);
    context.on('requestfinished', onRequestDone);
    context.on('requestfailed', onRequestDone);

    return {
        /**
         * Waits until all tracked requests have completed and the browser has
         * remained idle for a short period.
         *
         * The quiet period prevents a request that starts immediately after the
         * previous request finishes from being mistaken for an idle browser.
         *
         * @param {{
         *   quietMs?: number,
         *   timeoutMs?: number,
         * }} [options]
         * @returns {Promise<void>}
         */
        async waitForIdle({
            quietMs = 50,
            timeoutMs = 30_000,
        } = {}) {
            const deadline = Date.now() + timeoutMs;
            let idleSince = null;

            while (Date.now() < deadline) {
                if (pendingRequests.size === 0) {
                    idleSince ??= Date.now();

                    if (Date.now() - idleSince >= quietMs) {
                        return;
                    }
                } else {
                    idleSince = null;
                }

                await delay(10);
            }

            const pendingUrls = [...pendingRequests]
                .slice(0, 3)
                .map(request => request.url());
            const details = pendingUrls.length > 0
                ? `: ${pendingUrls.join(', ')}`
                : '';

            throw new Error(
                `Timed out waiting for browser requests `
                + `(${pendingRequests.size} still pending${details})`,
            );
        },

        /**
         * Removes the request listeners installed by this tracker.
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

    page.on('pageerror', (error) => {
        progress.error(`Page error: ${error.message}`);
    });

    page.on('console', (message) => {
        const text = message.text();
        const type = message.type();
        const url = message.location().url ?? '';

        // Missing baked images are expected and should not pollute the output.
        if (
            type === 'error'
            && text.includes('404')
            && url.includes('/baked/')
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
