# Design

Conventions for `@evu/harness-ui` and the demo web app.

## Principles

**The UI kit is a set of parts, not a page.** A host should be able to mount just
the composer, or just the transcript, or the whole chat surface. Anything that
assumes a specific page layout belongs in the host app.

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
half-closed fence does not flash a broken diagram on every token.

The status bar is tier-2: it takes protocol-shaped props (the public active
provider snapshot, `SessionUsage`, and the resolved max tokens). It does not
fetch. Context hover is a custom tooltip, not the browser `title` attribute, so
later lines can be added without fighting native tooltip limits.

A host mounting an assembly must be able to swap any tier-2 piece inside it.

Numeric fields that accept large values use k-notation. The person can type a
suffix; blur and save convert it to the expanded integer so the stored value
and the field agree. Invalid text is left as typed and is not written.

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

Icons are string tokens. The host supplies the token-to-component map, which is
what lets a terminal surface map the same tokens to glyphs.

Not every item becomes a chip: a menu or item may insert plain text instead, so
snippet and emoji style menus work without pretending to be references.

### Attachments

When `features.attachments` is on, the composer exposes an Attach control. Picked
images and files become the same chip chrome as context-menu picks, with wire
tokens like `[image:shot.png]` / `[file:notes.txt]` plus a structured
`attachments[]` array on send. Transcript rows may echo attachment chips (name
and kind) without re-embedding large data URLs.

## Gates

Tool approval, plan approval, ask-user, and mode-switch requests are modal
decisions. They share one visual language:

- state what will happen, concretely, including the exact arguments for a tool
- distinguish the widening scopes of an approval so that "always" never looks
  like the safe default
- keep the transcript readable behind the gate; do not lose context
- never auto-select a destructive option

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

## Accessibility

- Every control is reachable and operable by keyboard.
- The menu popup is a listbox with correct active-descendant semantics.
- Gates receive focus when they open and restore focus when they close.
- Streaming regions announce politely; they must not spam a screen reader on
  every token.
