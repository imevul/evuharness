/**
 * The context menu catalog.
 *
 * The pure engine — trigger detection, tree navigation, filtering, chip
 * resolution — lives in `@evu/harness-protocol` so a presentation layer can use it
 * without depending on the runtime. It is re-exported here so a runtime consumer
 * still sees one coherent surface.
 */

export {
  applyPickToText,
  defaultToken,
  detectTrigger,
  type FilterOptions,
  filterNodes,
  findItem,
  groupsAlongPath,
  isGroup,
  isItem,
  nodesAtPath,
  type ResolveChipInput,
  type ResolvedChip,
  resolveChip,
  TriggerDismissals,
  type TriggerMatch,
  walkItems,
} from '@evu/harness-protocol';

export * from './presets.js';
export * from './registry.js';
export * from './types.js';
