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
export { AgentSettings, type AgentSettingsProps } from './components/AgentSettings.js';
export {
  CompactionSettingsPanel,
  type CompactionSettingsProps,
} from './components/CompactionSettings.js';
export { Composer, type ComposerChrome, type ComposerProps } from './components/Composer.js';
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
export { McpSettings, type McpSettingsProps } from './components/McpSettings.js';
export { MemorySettings, type MemorySettingsProps } from './components/MemorySettings.js';
export { Modal, type ModalProps } from './components/Modal.js';
export {
  ModelPickerField,
  type ModelPickerFieldProps,
} from './components/ModelPickerField.js';
export { type PromptPreviewProps, PromptPreviewView } from './components/PromptPreview.js';
export {
  PromptSettings,
  type PromptSettingsProps,
} from './components/PromptSettings.js';
export {
  ProviderFormModal,
  type ProviderFormModalProps,
} from './components/ProviderFormModal.js';
export {
  ProviderMenu,
  type ProviderMenuOpenRequest,
  type ProviderMenuProps,
  type ProviderMenuRow,
} from './components/ProviderMenu.js';
export {
  ProviderOverrideControls,
  type ProviderOverrideControlsProps,
} from './components/ProviderOverrideControls.js';
export {
  ProviderSettings,
  type ProviderSettingsProps,
} from './components/ProviderSettings.js';
export { SearchSettings, type SearchSettingsProps } from './components/SearchSettings.js';
export { SessionSidebar, type SessionSidebarProps } from './components/SessionSidebar.js';
export {
  agentReadout,
  StatusBar,
  type StatusBarPickerRequest,
  type StatusBarProps,
} from './components/StatusBar.js';
export { Toggle, type ToggleProps } from './components/Toggle.js';
export { ToolCatalogView, type ToolCatalogViewProps } from './components/ToolCatalogView.js';
export {
  formatWorkedDuration,
  formatWorkedFor,
  progressNoteText,
  summarizeToolTrace,
  Transcript,
  type TranscriptProps,
} from './components/Transcript.js';
export { UsageFooter, type UsageFooterProps } from './components/UsageFooter.js';
export {
  attachmentFromFile,
  type ComposerAttachment,
  type ComposerChipRef,
  type ComposerValue,
  createAttachmentChipElement,
  createChipElement,
  deleteChipAfterCaret,
  deleteChipBeforeCaret,
  insertAttachmentAtCaret,
  isAttachmentChipElement,
  isChipRemoveElement,
  mergeComposerAttachments,
  mergeComposerRefs,
  paintComposer,
  removeChipElement,
  serializeComposer,
  setComposerCaret,
  toWireAttachments,
  toWireRefs,
} from './composer/serialize.js';
export { FOCUSABLE_SELECTOR, focusableWithin, trapTabKey } from './focus-trap.js';
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
  LIVE_TURN_POLL_MS,
  type LiveTurn,
  type SplitLiveSession,
  splitLiveSession,
  type UseHarnessSessionOptions,
  useHarnessSession,
} from './hooks/use-harness-session.js';
export { expandKNotation, formatContextWindow, parseKNotation } from './k-notation.js';
export {
  mergeProviderOverrides,
  resolveActiveProviderSnapshot,
  resolveModelContextWindow,
} from './provider-override.js';
export {
  isNearBottom,
  isWorkScroller,
  listWorkScrollers,
  SCROLL_BOTTOM_THRESHOLD_PX,
  WORK_SCROLL_THRESHOLD_PX,
  WORK_SCROLLER_SELECTOR,
} from './scroll.js';
