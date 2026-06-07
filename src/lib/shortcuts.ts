export interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface AppShortcutKeyEvent extends ShortcutKeyEvent {
  defaultPrevented?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}

export type AppShortcutAction = "open" | "save" | "saveAs";

const modifierKeys = new Set(["Alt", "Control", "Meta", "Shift"]);
const reservedAppShortcuts = new Set(["Mod-o", "Mod-s", "Mod-Shift-s"]);

export function appShortcutFromKeyboardEvent(
  event: AppShortcutKeyEvent,
): AppShortcutAction | null {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    event.altKey ||
    (!event.ctrlKey && !event.metaKey)
  ) {
    return null;
  }

  const key = normalizeKey(event.key);
  if (key === "o" && !event.shiftKey) {
    return "open";
  }
  if (key === "s") {
    return event.shiftKey ? "saveAs" : "save";
  }

  return null;
}

export function isReservedAppShortcut(shortcut: string): boolean {
  return reservedAppShortcuts.has(shortcut);
}

export function shortcutFromKeyboardEvent(event: ShortcutKeyEvent): string | null {
  if (modifierKeys.has(event.key)) {
    return null;
  }

  const key = normalizeKey(event.key);
  if (!key) {
    return null;
  }

  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) {
    modifiers.push("Mod");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }

  if (modifiers.length === 0 && !/^F\d{1,2}$/.test(key)) {
    return null;
  }

  return [...modifiers, key].join("-");
}

export function formatShortcutLabel(shortcut: string): string {
  return shortcut
    .split("-")
    .map((part) => {
      if (part === "Mod") {
        return "Ctrl/Cmd";
      }
      if (part.length === 1) {
        return part.toUpperCase();
      }
      return part;
    })
    .join(" + ");
}

function normalizeKey(key: string): string | null {
  if (!key || key === "Unidentified") {
    return null;
  }
  if (key === " ") {
    return "Space";
  }
  if (key === "Esc") {
    return "Escape";
  }
  if (key.length === 1) {
    return key.toLowerCase();
  }
  return key;
}
