/**
 * `@evu/harness-server` — the HTTP/SSE surface over the runtime.
 *
 * Exports an embeddable app rather than a process, so a host can mount the routes
 * inside an existing server. The demo application supplies the process.
 */

export * from './auth.js';
export * from './routes.js';
