import { setTimeout as delay } from 'node:timers/promises';

/**
 * @typedef {import('playwright').BrowserContext} BrowserContext
 * @typedef {import('playwright').Page} Page
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
    let pendingRequests = 0;

    const onRequest = () => {
        pendingRequests++;
    };

    const onRequestDone = () => {
        pendingRequests = Math.max(0, pendingRequests - 1);
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
                if (pendingRequests === 0) {
                    idleSince ??= Date.now();

                    if (Date.now() - idleSince >= quietMs) {
                        return;
                    }
                } else {
                    idleSince = null;
                }

                await delay(10);
            }

            throw new Error(
                `Timed out waiting for browser requests `
                + `(${pendingRequests} still pending)`,
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
        },
    };
}

/**
 * Installs diagnostic logging for browser failures, page errors, and console
 * messages.
 *
 * @param {BrowserContext} context Browser context used by the packer.
 * @param {Page} page Localization-tool page.
 * @returns {void}
 */
export function installBrowserLogging(context, page) {
    context.on('requestfailed', (request) => {
        const failure = request.failure();

        console.error(
            `Request failed: ${request.method()} ${request.url()}`
            + ` (${failure?.errorText ?? 'unknown error'})`,
        );
    });

    page.on('pageerror', (error) => {
        console.error(`Page error: ${error.message}`);
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

        console.log(
            url.length > 0
                ? `${prefix} ${text} (${url})`
                : `${prefix} ${text}`,
        );
    });
}
