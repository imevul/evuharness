/**
 * `@evu/harness-ui` — the React presentation layer.
 *
 * Depends only on `@evu/harness-protocol`, never on the runtime. That boundary is
 * what makes another surface possible: a TUI reimplements this package and keeps
 * everything else. It also keeps Node built-ins out of a browser bundle.
 *
 * Components ship structure and `data-harness` attributes rather than styles, so a
 * host themes them with its own design system instead of overriding ours.
 */

export { HarnessClient, type HarnessClientOptions, HarnessRequestError } from './client.js';
export { Composer, type ComposerProps } from './components/Composer.js';
export {
  ContextMenuPopup,
  type ContextMenuPopupProps,
} from './components/ContextMenuPopup.js';
export { AskUserGate, type AskUserGateProps } from './components/gates/AskUserGate.js';
export { GateStack, type GateStackProps } from './components/gates/GateStack.js';
export { ModeSwitchGate, type ModeSwitchGateProps } from './components/gates/ModeSwitchGate.js';
export { PlanGate, type PlanGateProps } from './components/gates/PlanGate.js';
export {
  ToolApprovalGate,
  type ToolApprovalGateProps,
} from './components/gates/ToolApprovalGate.js';
export {
  isAllowedImageSrc,
  MarkdownView,
  type MarkdownViewProps,
} from './components/MarkdownView.js';
export { type PromptPreviewProps, PromptPreviewView } from './components/PromptPreview.js';
export {
  ProviderSettings,
  type ProviderSettingsProps,
} from './components/ProviderSettings.js';
export { SessionSidebar, type SessionSidebarProps } from './components/SessionSidebar.js';
export { StatusBar, type StatusBarProps } from './components/StatusBar.js';
export { ToolCatalogView, type ToolCatalogViewProps } from './components/ToolCatalogView.js';
export { Transcript, type TranscriptProps } from './components/Transcript.js';
export { UsageFooter, type UsageFooterProps } from './components/UsageFooter.js';
export {
  type ComposerChipRef,
  type ComposerValue,
  createChipElement,
  deleteChipAfterCaret,
  deleteChipBeforeCaret,
  mergeComposerRefs,
  paintComposer,
  serializeComposer,
  setComposerCaret,
  toWireRefs,
} from './composer/serialize.js';
export {
  type ContextMenuFetcher,
  type ContextMenuState,
  itemForRef,
  type UseContextMenuOptions,
  useContextMenu,
} from './hooks/use-context-menu.js';
export {
  applyStreamEvent,
  type HarnessSessionState,
  type LiveTurn,
  type UseHarnessSessionOptions,
  useHarnessSession,
} from './hooks/use-harness-session.js';
export { expandKNotation, parseKNotation } from './k-notation.js';
