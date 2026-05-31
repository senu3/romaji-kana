import { invoke, isTauri } from "@tauri-apps/api/core";

export interface OpenedMarkdownFile {
  path: string;
  content: string;
}

export async function openMarkdownFile(): Promise<OpenedMarkdownFile | null> {
  ensureTauriFileAccess();
  return invoke<OpenedMarkdownFile | null>("open_markdown_file");
}

export async function saveMarkdownFile(
  content: string,
  path?: string | null,
): Promise<string | null> {
  ensureTauriFileAccess();
  return invoke<string | null>("save_markdown_file", {
    path: path ?? null,
    content,
  });
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function ensureTauriFileAccess(): void {
  if (!isTauri()) {
    throw new Error("File open/save is available in the Tauri desktop app.");
  }
}
