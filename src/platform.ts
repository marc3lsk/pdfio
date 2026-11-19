// Thin bridge to Tauri with a browser fallback, so the UI can also be developed with plain `vite`.
import { invoke } from "@tauri-apps/api/core";

export const isTauri = "__TAURI_INTERNALS__" in window;

export interface OpenedFile {
  path: string | null;
  name: string;
  bytes: Uint8Array;
}

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export async function readPath(path: string): Promise<OpenedFile> {
  const buf = await invoke<ArrayBuffer>("read_file", { path });
  return { path, name: baseName(path), bytes: new Uint8Array(buf) };
}

export async function writePath(path: string, bytes: Uint8Array): Promise<void> {
  await invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(path) } });
}

export async function pickFiles(): Promise<OpenedFile[]> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sel = await open({ multiple: true, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (!sel) return [];
    return Promise.all((Array.isArray(sel) ? sel : [sel]).map(readPath));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pdf,application/pdf";
    input.multiple = true;
    input.onchange = async () => resolve(await filesToOpened(Array.from(input.files ?? [])));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function filesToOpened(files: File[]): Promise<OpenedFile[]> {
  return Promise.all(
    files.map(async (f) => ({ path: null, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
  );
}

/** Ask for a target path. Returns null when cancelled. In the browser this triggers a download instead. */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri) return defaultName;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: defaultName, filters: [{ name: "PDF", extensions: ["pdf"] }] });
}

export async function saveBytes(path: string, bytes: Uint8Array): Promise<void> {
  if (isTauri) return writePath(path, bytes);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: baseName(path) });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function confirmDialog(message: string): Promise<boolean> {
  if (!isTauri) return window.confirm(message);
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(message, { title: "PDFio", kind: "warning", okLabel: "Zahodiť", cancelLabel: "Zrušiť" });
}

export async function setWindowTitle(title: string) {
  document.title = title;
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTitle(title);
}

export async function showWindow() {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().show();
}

export async function windowControl(action: "minimize" | "toggleMaximize" | "close") {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  if (action === "minimize") await w.minimize();
  else if (action === "toggleMaximize") await w.toggleMaximize();
  else await w.close(); // goes through onCloseRequested (unsaved-changes guard)
}

/** Calls back with the current maximized state now and after every resize. */
export async function onWindowMaximized(cb: (maximized: boolean) => void) {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  const update = async () => cb(await w.isMaximized());
  await update();
  await w.onResized(() => void update());
}

/** Wire OS-level integrations: command-line files, second instance, drag&drop, close guard. */
export async function wireNative(opts: {
  onFiles: (paths: string[]) => void;
  onBrowserFiles: (files: File[]) => void;
  canClose: () => Promise<boolean>;
}) {
  if (!isTauri) {
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      opts.onBrowserFiles(Array.from(e.dataTransfer?.files ?? []));
    });
    return;
  }
  const [{ listen }, { getCurrentWebview }, { getCurrentWindow }] = await Promise.all([
    import("@tauri-apps/api/event"),
    import("@tauri-apps/api/webview"),
    import("@tauri-apps/api/window"),
  ]);
  await listen<string[]>("open-files", (e) => opts.onFiles(e.payload));
  await getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === "drop") {
      opts.onFiles(e.payload.paths.filter((p) => /\.pdf$/i.test(p)));
    }
  });
  const win = getCurrentWindow();
  await win.onCloseRequested(async (e) => {
    e.preventDefault();
    if (await opts.canClose()) await win.destroy();
  });
  const initial = await invoke<string[]>("take_initial_files");
  if (initial.length) opts.onFiles(initial);
}
