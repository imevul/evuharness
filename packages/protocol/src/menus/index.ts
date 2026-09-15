/**
 * The pure context menu engine.
 *
 * Trigger detection, tree navigation, filtering, and chip resolution are all
 * dependency-free functions over the protocol's own types. They live here rather
 * than in the runtime because both sides need them: a composer resolves chips and
 * detects triggers in the browser, and the runtime filters the same trees when it
 * serves a menu level.
 *
 * The UI kit depends only on this package, so putting the engine here is what
 * keeps there being exactly one trigger detector instead of one per surface.
 * Nothing in this directory touches the DOM, the filesystem, or Node built-ins.
 */

export * from './chips.js';
export * from './nodes.js';
export * from './trigger.js';
