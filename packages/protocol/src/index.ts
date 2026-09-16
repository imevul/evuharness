/**
 * `@evu/harness-protocol` — the wire contract every EvuHarness surface shares.
 *
 * This package is schema-only: no runtime behavior, no HTTP, no DOM. Both the
 * in-process path and the HTTP/SSE path depend on it, which is what keeps a
 * non-web surface from needing its own definitions.
 */

export * from './attachments.js';
export * from './context-menus.js';
export * from './events.js';
export * from './gates.js';
export * from './menus/index.js';
export * from './rest.js';
export * from './session.js';
export * from './settings.js';
export * from './sse.js';
export * from './tools.js';

/** Wire-format version, bumped when a breaking protocol change ships. */
export const PROTOCOL_VERSION = '0' as const;
