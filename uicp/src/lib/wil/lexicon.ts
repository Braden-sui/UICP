import type { OperationNameT } from "../uicp/schemas";

// Basic slot spec types (lightweight for now; can be expanded or generated)
export type SlotSpec =
  | { kind: "wildcard" }
  | { kind: "range"; min?: number; max?: number }
  | { kind: "enum"; values: readonly string[] };

type LexEntry<K extends OperationNameT> = {
  // Phantom property to use the generic type parameter for type safety
  readonly _operation?: K;
  // Canonical verb + synonyms
  verbs: readonly [string, ...string[]];
  // Templates use tokens with {slot} placeholders
  templates: readonly string[];
  // Slot hints (optional today; parser is permissive and Zod validates later)
  slots?: Record<string, SlotSpec | undefined>;
  // Words or phrases to ignore when matching
  skip?: readonly string[];
};

// Exhaustive, exact mapping: cover every OperationNameT key.
// Keep templates minimal and deterministic; expand as needed.
export const LEXICON: { [K in OperationNameT]: LexEntry<K> } = {
  // Windows -----------------------------------------------------------------
  "window.create": {
    verbs: ["create", "make", "open", "new"],
    templates: [
      // ID-specific templates first (most specific patterns)
      "create window id {id} title {title} width {width} height {height}",
      "create window id {id} title {title} size {size}",
      "create window id {id} title {title} at {x},{y}",
      "create window id {id} title {title}",
      // Generic templates without ID
      "create window title {title} width {width} height {height}",
      "create window title {title} size {size}",
      "create window title {title} at {x},{y}",
      "create window title {title}",
      // Additional verb variations for agent flexibility
      "new window id {id} title {title} width {width} height {height}",
      "new window id {id} title {title}",
      "new window title {title} width {width} height {height}",
      "new window title {title} size {size}",
      "new window title {title} at {x},{y}",
      "new window title {title}",
      "make window title {title} width {width} height {height}",
      "make window title {title} size {size}",
      "make window title {title}",
      "open window title {title}",
    ],
    skip: ["please", "can you", "the", "a"],
  },
  "window.update": {
    verbs: ["update", "change", "set"],
    templates: [
      "update window {id}",
      "update window {id} title {title}",
      "update window {id} width {width} height {height}",
      "update window {id} at {x},{y}",
      "update window {id} zindex {zIndex}",
      "move window {id} to {x},{y}",
      "resize window {id} to {width}x{height}",
    ],
    skip: ["please", "the"],
  },
  "window.close": {
    verbs: ["close", "hide"],
    templates: ["close window {id}", "close window"],
    skip: ["please", "the"],
  },

  // DOM ---------------------------------------------------------------------
  "dom.set": {
    verbs: ["set", "put"],
    templates: [
      "set html in {target} of window {windowId} to {html}",
      "set html in {target} to {html}",
      "set inner html in {target} of window {windowId} to {html}",
      "set inner html in {target} to {html}",
      "set inner html of {target} of window {windowId} to {html}",
      "set inner html of {target} to {html}",
      "insert html in {target} of window {windowId} {html}",
      "insert html in {target} {html}",
    ],
    skip: ["please"],
  },
  "dom.replace": {
    verbs: ["replace"],
    templates: [
      "replace html in {target} of window {windowId} with {html}",
      "replace html in {target} with {html}",
      "swap html in {target} of window {windowId} with {html}",
      "swap html in {target} with {html}",
      "replace in {target} of window {windowId} with {html}",
      "replace in {target} with {html}",
      "replace {target} of window {windowId} with {html}",
      "replace {target} with {html}",
    ],
    skip: ["please"],
  },
  "dom.append": {
    verbs: ["append", "add"],
    templates: [
      "append html in {target} of window {windowId} with {html}",
      "append html in {target} with {html}",
      "add html in {target} of window {windowId} {html}",
      "add html in {target} {html}",
      "add to {target} of window {windowId} {html}",
      "add to {target} {html}",
      "append to {target} of window {windowId} {html}",
      "append to {target} {html}",
      "append {html} to {target} of window {windowId}",
      "append {html} to {target}",
      "add {html} to {target} of window {windowId}",
      "add {html} to {target}",
    ],
    skip: ["please"],
  },

  // Components ---------------------------------------------------------------
  "component.render": {
    verbs: ["render", "mount"],
    templates: [
      "render component {type} in window {windowId} at {target}",
      "render component {type} at {target}",
      "mount {type} in {target}",
      "render component {type} in window {windowId} at {target} with {props}",
    ],
    skip: ["please", "the"],
  },
  "component.update": {
    verbs: ["update", "patch"],
    templates: [
      "update component {id}",
      "update component {id} props {props}",
      "update component {id} with {props}",
      "update component {id} with props {props}",
      "patch component {id} with {props}",
      "set component {id} props {props}",
      "set component {id} to {props}",
      "update props on component {id} {props}",
      "change component {id} props to {props}",
    ],
    skip: ["please"],
  },
  "component.destroy": {
    verbs: ["destroy", "remove", "unmount"],
    templates: ["destroy component {id}"],
    skip: ["please", "the"],
  },

  // State -------------------------------------------------------------------
  "state.set": {
    verbs: ["set", "store"],
    templates: [
      "set state {key} to {value} in {scope}",
      "set state {key} to {value}",
      "store state {key} {value} in {scope}",
    ],
    skip: ["please", "the"],
  },
  "state.get": {
    verbs: ["get", "read"],
    templates: ["get state {key} in {scope}", "get state {key}", "read state {key} in {scope}"],
    skip: ["please", "the"],
  },
  "state.watch": {
    verbs: ["watch", "observe"],
    templates: ["watch state {key} in {scope}", "watch state {key}", "observe state {key} in {scope}"],
    skip: ["please", "the"],
  },
  "state.unwatch": {
    verbs: ["unwatch", "stop watching"],
    templates: ["unwatch state {key} in {scope}", "unwatch state {key}", "stop watching state {key} in {scope}"],
    skip: ["please", "the"],
  },

  // HTTP/API ----------------------------------------------------------------
  "api.call": {
    verbs: ["open", "visit", "go"],
    templates: [
      "open url {url}",
      "visit {url}",
      "go to {url}",
      "open {url}",
      "api {method} {url}",
    ],
    skip: ["please"],
  },

  // Txn ---------------------------------------------------------------------
  "txn.cancel": {
    verbs: ["cancel", "abort", "stop"],
    templates: ["cancel txn {id}", "cancel"],
    skip: ["please"],
  },
};

export type Lexicon = typeof LEXICON;
