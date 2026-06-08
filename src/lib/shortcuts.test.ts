import { describe, expect, it } from "vitest";
import {
  appShortcutFromKeyboardEvent,
  formatShortcutLabel,
  isReservedAppShortcut,
  shortcutFromKeyboardEvent,
} from "./shortcuts";

describe("shortcutFromKeyboardEvent", () => {
  it("normalizes Ctrl and Meta to the cross-platform Mod modifier", () => {
    expect(
      shortcutFromKeyboardEvent({
        key: "Enter",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("Mod-Enter");

    expect(
      shortcutFromKeyboardEvent({
        key: "s",
        ctrlKey: false,
        metaKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("Mod-s");
  });

  it("keeps additional modifiers in CodeMirror keymap order", () => {
    expect(
      shortcutFromKeyboardEvent({
        key: "K",
        ctrlKey: true,
        metaKey: false,
        altKey: true,
        shiftKey: true,
      }),
    ).toBe("Mod-Alt-Shift-k");
  });

  it("rejects bare character keys but allows function keys", () => {
    expect(
      shortcutFromKeyboardEvent({
        key: "a",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();

    expect(
      shortcutFromKeyboardEvent({
        key: "F2",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("F2");
  });
});

describe("formatShortcutLabel", () => {
  it("renders a user-facing shortcut label", () => {
    expect(formatShortcutLabel("Mod-Shift-p")).toBe("Ctrl/Cmd + Shift + P");
  });
});

describe("appShortcutFromKeyboardEvent", () => {
  it("maps common file shortcuts", () => {
    expect(
      appShortcutFromKeyboardEvent({
        key: "n",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("new");

    expect(
      appShortcutFromKeyboardEvent({
        key: "o",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("open");

    expect(
      appShortcutFromKeyboardEvent({
        key: "s",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("save");

    expect(
      appShortcutFromKeyboardEvent({
        key: "S",
        ctrlKey: false,
        metaKey: true,
        altKey: false,
        shiftKey: true,
      }),
    ).toBe("saveAs");
  });

  it("ignores composing, repeated, and alternate shortcuts", () => {
    expect(
      appShortcutFromKeyboardEvent({
        key: "s",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: true,
      }),
    ).toBeNull();

    expect(
      appShortcutFromKeyboardEvent({
        key: "s",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        repeat: true,
      }),
    ).toBeNull();

    expect(
      appShortcutFromKeyboardEvent({
        key: "o",
        ctrlKey: true,
        metaKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toBeNull();
  });
});

describe("isReservedAppShortcut", () => {
  it("reserves file shortcuts for app actions", () => {
    expect(isReservedAppShortcut("Mod-n")).toBe(true);
    expect(isReservedAppShortcut("Mod-o")).toBe(true);
    expect(isReservedAppShortcut("Mod-s")).toBe(true);
    expect(isReservedAppShortcut("Mod-Shift-s")).toBe(true);
    expect(isReservedAppShortcut("Mod-Enter")).toBe(false);
  });
});
