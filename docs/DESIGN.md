# Design

Conventions for `@evu/harness-ui` and the demo web app.

## Principles

**The UI kit is a set of parts, not a page.** A host should be able to mount just
the composer, or just the transcript, or the whole chat surface. Anything that
assumes a specific page layout belongs in the host app. How those parts are
chosen and wired is covered in [`INTEGRATION.md`](./INTEGRATION.md).

**Protocol types are the only contract.** Components take and return protocol
shapes. A component that needs a host-specific type is in the wrong package.

**Every asynchronous state is visible.** Streaming, waiting on an approval,
waiting on an answer, and cancelling are all distinct states with distinct
affordances. Silence is a bug.

## Composability

Exported components fall into three tiers:

1. **Primitives** — transcript rows, chips, the menu popup, the markdown
   renderer. No data fetching.
2. **Bound components** — composer, transcript, session list. These take a client
   plus callbacks; they do not own routing or global state.
3. **Assemblies** — a full chat surface for hosts that want the default.

The markdown renderer is a primitive the transcript uses, not a second page.
Completed rows go through it. The live streaming bubble stays plain text so a
half-closed fence does not flash a broken diagram on every token. If the bubble
uses `white-space: pre-wrap` for that live path, reset the markdown root to
`normal` and collapse default `p` / `ul` margins — otherwise every blank line
in a loose list becomes a full extra gap.

The status bar is tier-2: it takes protocol-shaped props (the public active
provider snapshot, `SessionUsage`, and the resolved max tokens). It does not
reach the network itself — its model list arrives through a host callback, and
only when that row is opened. Context hover is a custom tooltip, not the browser
`title` attribute, so later lines can be added without fighting native tooltip
limits.

A host mounting an assembly must be able to swap any tier-2 piece inside it.

Numeric fields that accept large values use k-notation. The person can type a
suffix; blur and save convert it to the expanded integer so the stored value
and the field agree. Invalid text is left as typed and is not written.

The reverse direction is display-only. Where a stored integer is shown back as a
hint, `formatContextWindow` renders the shortest form that still parses to the
same number, preferring the decimal reading when both are exact: `32768` is
`32Ki`, `128000` is `128K`, and anything without a clean division stays a grouped
integer. A hint that does not round-trip would teach the wrong input.

## Context menus

One popup renders every registered menu. It must handle, from the same data:

- flat item lists
- grouped items with drill-in
- lazily fetched children at any depth
- keyboard-first navigation, including escape to dismiss without reopening

Dismissal is sticky per trigger occurrence: once a user escapes out of a menu,
retyping must not reopen it for that same trigger character until they move on.

### Chips

A chip is the inserted form of a picked item. Presentation resolves in one
direction, most specific first:

- **Icon:** the chip override, then the item, then the nearest ancestor group
  along the drill-in path, then the menu default, then the trigger character.
- **Label:** the chip override, then the item label.
- **Hint** never appears in a chip. It is picker-only disambiguation text.
- **Tone** is chip-only styling.
- **Remove** is a trailing `chip-remove` control on every composer chip
  (mentions, commands, attachments). It deletes the chip; it is not painted
  on transcript chips, which are already sent.

Icons are string tokens. The host supplies the token-to-component map, which is
what lets a terminal surface map the same tokens to glyphs.

Not every item becomes a chip: a menu or item may insert plain text instead, so
snippet and emoji style menus work without pretending to be references. An item
with `action` does not insert at all: the trigger is removed and `Composer`
reports `onAction`. That is how `/model` opens the status-bar model flyout
and `/plan` stages plan mode, without sending a turn.

### Attachments

When `features.attachments` is on, the composer exposes an Attach control. Picked
images and files become the same chip chrome as context-menu picks, with wire
tokens like `[image:shot.png]` / `[file:notes.txt]` plus a structured
`attachments[]` array on send. Chip DOM only stores identity (id, name, kind);
image data URLs and file text stay on composer state so paint cannot choke on a
payload. Transcript rows may echo attachment chips (name and kind) without
re-embedding those payloads.

## Gates

Tool approval, plan approval, ask-user, and mode-switch requests are modal
decisions. They share one visual language:

- state what will happen, concretely, including the exact arguments for a tool
- distinguish the widening scopes of an approval so that "always" never looks
  like the safe default
- keep the transcript readable behind the gate; do not lose context
- never auto-select a destructive option

## Dialogs

`Modal` is the kit's dialog primitive: `role="dialog"`, `aria-modal`, a labelled
title, focus moved into the body on open (or to `[data-autofocus]`), Tab trapped
inside the panel, focus restored to the opener on close, and Escape and backdrop
dismissal that a caller can switch off while a decision is pending. Like the rest
of the kit it ships no styles, only `data-harness` hooks.

**Gates are not dialogs.** A queued tool approval has to stay visible while the
person reads the transcript behind it and while other work is pending, which a
dialog stack cannot express. Gates stay inline; dialogs are for editing
something, where losing the surrounding view for a moment is the point.

## Composer chrome

The default chrome is **inlaid**: a `+` add menu, a dismissible mode chip next
to it, and icon send/stop on the trailing edge. A single-line draft sits
between those controls. A wrapped or multi-line draft stacks the field above
the button row and caps the field at `12rem` with overflow. A chip on one
line stays single: chip chrome is taller than the text line, and a
contenteditable caret break after a chip is not a second line. `agent` is
unmarked — the chip is hidden until the draft is ask or plan. The chip shows
the same icon as the add menu and a title-cased label. Ask reads green, plan
yellow, in the demo stylesheet. Pass `chrome="bar"` for the original
under-editor row. `trailingActions` is the slot a later voice control would
occupy.

The add menu opens with a focused search field. Empty query lists modes,
attach, and catalog triggers as icon + label rows. The leading mark is a
short glyph (mode SVG, attach paperclip, or the catalog trigger). Long
icon tokens stay off the row so they cannot paint over the label. Typing
filters those rows and fetches matching items from each catalog (commands,
mentions, and any host menu) through the same `fetchItems` the `@` / `/`
popup uses. A category row still inserts that menu's trigger; a hit inserts
the chip (or fires `onAction`) at the caret.

## Modes

The mode control is a draft: changing it must not call the server. It stages the
next send. This is what makes toggling safe while a turn streams, and the UI
should not imply otherwise by showing a spinner or disabling the control.

After a gate changes the session mode, the control resyncs from the terminal
stream event.

## Provider overrides

Provider / model / effort selection has the same ownership split as modes:

- **Settings active profile** — named profiles in settings. Overrides never rewrite
  them unless the person edits settings.
- **Session preference** — persisted on the session via an explicit set-provider
  call. Survives reloads; does not change settings.
- **Per-send draft** — local only. Staging for the next chat request; cleared or
  ignored after send. Mid-turn edits must not touch the session.

Precedence for a turn is turn > session > settings. The status bar shows the
effective provider and model after those layers.

**The status bar readout is also the control.** It already names the provider and
model, and it is on screen during every turn, so a separate always-open override
panel above the composer was permanent chrome restating one line of text.
`StatusBar` takes `providers` plus `onProviderChange` and turns the readout into a
popover over `ProviderMenu`; without those props it stays display-only. Only
`active` provider profiles appear in that picker. When `features.agents` is on,
the bar also offers an agent dropdown: None uses no agent, and a pick pins one
agent on the session. The context donut sits at the trailing edge of the bar.

`ProviderMenu` is rows, not stacked selects: Provider, Model, Effort, and a
read-only Context, each stating its current value in place so the common case —
reading what is running — needs no further clicks. One flyout opens at a time, and
Escape inside a flyout backs out one level rather than dismissing the whole
popover.

Models load when the model row opens, through the host's `onListModels`. Listing
is a network call against an endpoint that may be asleep, so paying for it on
every status bar render would make reading the value the expensive operation. The
list is per provider and refetched when the chosen provider changes; until it
lands the row falls back to the ids already stored on the profile. Choosing a
different provider also drops a pinned model, because a model id only means
something on the endpoint that serves it.

The demo surfaces only the session scope. All three layers still exist in the
protocol, and a host that wants per-send staging mounts
`ProviderOverrideControls` with `draft` and passes `ChatRequest.provider` — but
two override scopes on one screen, identical in appearance and both reading
"inherit" almost always, cost more attention than the distinction is worth.

## Settings

Settings is a screen, not a panel. It owns the window and carries its own sidebar
of sections, because a settings pane squeezed beside the session list gives every
section a column too narrow to read and hides the rest of them below the fold.
The demo opens Settings from a gear at the bottom of the session list. The
settings sidebar holds `Back to chat` and one entry per section with a one-line
hint of what lives there; the section list and its layout belong to the host, not
to the kit.

Named profiles are a list, and editing is a dialog. An always-open form has to
show one profile at a time and then cannot say which profile turns actually use —
"the row I am editing" and "the default profile" are different facts and both have
to be on screen. So the list carries an iOS-style active switch (offered in the
picker), a Default badge or Set as default, and icon buttons for edit and delete;
delete goes through a confirm. The switch is `Toggle` (`role="switch"`,
`data-harness="toggle"`) — style-free in the kit; the demo paints it as an
iOS-style pill.

The same list-plus-modal chrome is reused for optional builtins that a host
turns on: Agents (soul textarea plus the same active switch — several souls may
be on at once), Search (DuckDuckGo / SearXNG), and MCP
(server URL plus optional bearer). Memory is a USER.md editor plus a searchable
MEMORY list. Compaction is strategy, target percent, and keep-recent. A flag
that is off does not appear in the sidebar at all — the section list is assembled
from `status.features`, not hardcoded as the full set.

**Model fields are free text with a Browse picker beside them,** never a closed
dropdown. A provider may serve a model it does not advertise, and a control that
refuses unknown ids makes that model unreachable. The picker fetches the catalog
when it opens — a running endpoint gains and loses models — and renders loading,
error, empty, and list as distinct states.

Where a number has a source other than the field itself, say so under the field.
The context window input shows whether the effective value is an override, came
from the provider's catalog, or is simply unknown for that model, so an empty
field does not read as "zero" or as "failed to load". Both that hint and the
status bar donut resolve through `resolveModelContextWindow`, so they cannot
disagree about what a turn will use.

## Streaming and navigation

A live stream must survive navigation within the host app. Keep the streaming
state above the route boundary rather than inside a page component.

The kit's `useHarnessSession` follows that rule when the host mounts it once for
the active session. Remounting the hook aborts only the local SSE reader; the
server keeps the turn running. On remount or unexpected stream failure the hook
reloads session detail, and when `turnInProgress` is set it rebuilds the live
bubble from any partial assistant row and polls until the turn completes.

Hosts that build their own client should do the same: prefer retaining the
stream owner across routes, and treat `turnInProgress` plus partial transcript
rows as the reconnect contract. The server emits SSE comment keep-alives during
an open turn so quiet gate/tool waits do not idle-timeout the connection.

## Reasoning

Providers may emit `reasoning_delta`. The transcript shows that text in a
collapsed secondary block (`data-harness="reasoning"`), never as the assistant
bubble. Live turns open the block while streaming so tokens stay visible;
completed rows keep it collapsed. Hosts theme the attribute; the kit does not
ship a glow or accent treatment for it.

Assistant turns fold thinking, `report_progress` notes, and tool calls into one
disclosure (`data-harness="work-trace"`). The latest completed turn and the live
turn keep it open; older turns stay collapsed. The summary is `Worked for 12s`
when `startedAt` and `createdAt` are present, `Worked` when they are not, and
`Working` while a turn is still in flight. Opening it restores the thinking
block, the inline progress notes (`data-harness="progress-note"`), and the
per-tool argument and result details. A turn with neither reasoning, notes, nor
tools omits the chrome.

`report_progress` is not rendered as a tool row. Its `text` argument is the
note. Hosts theme the attributes; the kit does not ship a glow or accent
treatment for them.

The transcript frame (`data-harness="transcript-frame"`) owns stick-to-bottom.
While the person is at the end of the scroller, new tokens and rows keep them
there. Scrolling away unpins and shows a jump control
(`data-harness="scroll-bottom"`) at the bottom center. Clicking it pins again.
Thinking and tool panes (`[data-harness="reasoning"] pre` and
`[data-harness="tool"] pre`) use the same pin as the transcript: follow only
while that pane is at its end, unpin when the person scrolls it up, and resume
when they scroll it back down. Each pane keeps its own pin.
A host that remounts the transcript on session change (a `key` on the session
id) lands at the latest row of the newly selected chat.

## Accessibility

- Every control is reachable and operable by keyboard.
- The menu popup is a listbox with correct active-descendant semantics.
- Gates receive focus when they open and restore focus when they close.
- Streaming regions announce politely; they must not spam a screen reader on
  every token.
