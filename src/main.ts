import "./styles.css";
import "pdfjs-dist/web/pdf_viewer.css";
import * as pdfjsLib from "pdfjs-dist";
import { EventBus, PDFFindController, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { FIELD_TYPE_LABEL, FormEditor, type FieldInfo, type FieldPatch, type FieldType, type Rect } from "./forms";
import { analyzeSignatures, fmtDate, overallStatus, type SigInfo, type SigStatus } from "./signatures";
import {
  baseName,
  confirmDialog,
  filesToOpened,
  pickFiles,
  pickSavePath,
  readPath,
  saveBytes,
  setWindowTitle,
  showWindow,
  isTauri,
  windowControl,
  onWindowMaximized,
  wireNative,
  type OpenedFile,
} from "./platform";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// ---------------------------------------------------------------- types / state

type AddType = Exclude<FieldType, "unknown">;

interface Tab {
  id: number;
  path: string | null;
  name: string;
  bytes: Uint8Array;
  dirty: boolean;
  doc: pdfjsLib.PDFDocumentProxy | null;
  host: HTMLDivElement;
  container: HTMLDivElement;
  viewer: PDFViewer;
  eventBus: EventBus;
  linkService: PDFLinkService;
  // forms
  editor: FormEditor | null;
  fields: FieldInfo[] | null;
  fieldCount: number;
  orphans: number;
  selected: string | null;
  selectedWidget: number;
  editMode: boolean;
  addType: AddType | null;
  queue: Promise<unknown>;
  /** edits already visible in the UI but not yet written to the PDF (debounced) */
  pending: ((ed: FormEditor) => string | void)[];
  commitTimer: number;
  // undo / redo: snapshots of whole-PDF bytes (tab.bytes is the current state)
  undo: Uint8Array[];
  redo: Uint8Array[];
  /** the bytes that match what is on disk (dirty = bytes differ) */
  clean: Uint8Array;
  /** user typed into a form widget since values were last folded into tab.bytes */
  touched: boolean;
  // digital signatures (null = not analyzed yet)
  sigs: SigInfo[] | null;
  sigSource: Uint8Array | null;
  selectedSig: number | null;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const tabs: Tab[] = [];
let active: Tab | null = null;
let nextId = 1;
let sideOpen = false;
/** the side panel shows signatures instead of form fields */
let sigOpen = false;

const PDF_ASSETS = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  wasmUrl: "/pdfjs/wasm/",
  iccUrl: "/pdfjs/iccs/",
  isEvalSupported: false,
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

let toastTimer = 0;
function toast(msg: string) {
  let el = document.getElementById("toast");
  if (!el) {
    el = Object.assign(document.createElement("div"), { id: "toast" });
    document.body.append(el);
  }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.remove(), 4000);
}
const fail = (e: unknown) => {
  console.error(e);
  toast(e instanceof Error ? e.message : String(e));
};

// ---------------------------------------------------------------- theme

type Theme = "auto" | "light" | "dark";
function getTheme(): Theme {
  try {
    return (localStorage.getItem("theme") as Theme) || "auto";
  } catch {
    return "auto";
  }
}
function applyTheme(t: Theme) {
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("theme", t);
  } catch {}
  $("btn-theme").title = { auto: "Téma: auto (klik = svetlá)", light: "Téma: svetlá (klik = tmavá)", dark: "Téma: tmavá (klik = auto)" }[t];
}

// ---------------------------------------------------------------- tabs

function createTab(file: OpenedFile): Tab {
  const host = document.createElement("div");
  host.className = "viewer-host inactive";
  const container = document.createElement("div");
  container.className = "pdfcontainer";
  container.tabIndex = 0;
  const viewerEl = document.createElement("div");
  viewerEl.className = "pdfViewer";
  container.append(viewerEl);
  host.append(container);
  $("viewers").append(host);

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const findController = new PDFFindController({ linkService, eventBus });
  const viewer = new PDFViewer({ container, viewer: viewerEl, eventBus, linkService, findController, removePageBorders: true });
  linkService.setViewer(viewer);

  const tab: Tab = {
    id: nextId++,
    path: file.path,
    name: file.name,
    bytes: file.bytes,
    dirty: false,
    doc: null,
    host,
    container,
    viewer,
    eventBus,
    linkService,
    editor: null,
    fields: null,
    fieldCount: 0,
    orphans: 0,
    selected: null,
    selectedWidget: 0,
    editMode: false,
    addType: null,
    queue: Promise.resolve(),
    pending: [],
    commitTimer: 0,
    undo: [],
    redo: [],
    clean: file.bytes,
    touched: false,
    sigs: null,
    sigSource: null,
    selectedSig: null,
  };

  eventBus.on("pagechanging", (e: { pageNumber: number }) => {
    if (tab === active) ($("page") as HTMLInputElement).value = String(e.pageNumber);
  });
  eventBus.on("scalechanging", () => tab === active && syncZoom());
  eventBus.on("pagerendered", (e: { pageNumber: number }) => {
    renderOverlay(tab, e.pageNumber);
    renderSigOverlay(tab, e.pageNumber);
  });
  eventBus.on("updatefindmatchescount", (e: { matchesCount: { current: number; total: number } }) => {
    if (tab === active) showFindCount(e.matchesCount);
  });
  eventBus.on("updatefindcontrolstate", (e: { state: number; matchesCount: { current: number; total: number } }) => {
    if (tab === active) showFindCount(e.matchesCount, e.state);
  });

  // pdf.js writes default values into annotationStorage on render, so only real user input counts as a change
  const userEdit = (e: Event) => {
    if (!(e.target as HTMLElement).closest(".annotationLayer")) return;
    tab.touched = true;
    setDirty(tab, true);
    // a committed value (blur / Enter / click) becomes one undo step
    if (e.type === "change") void exclusive(tab, () => currentBytes(tab)).catch(fail);
  };
  container.addEventListener("input", userEdit);
  container.addEventListener("change", userEdit);

  container.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.deltaY < 0 ? viewer.increaseScale({ steps: 1 }) : viewer.decreaseScale({ steps: 1 });
    },
    { passive: false },
  );
  return tab;
}

async function openFiles(files: OpenedFile[]) {
  for (const f of files) {
    const existing = f.path && tabs.find((t) => t.path?.toLowerCase() === f.path!.toLowerCase());
    if (existing) {
      activate(existing);
      continue;
    }
    const tab = createTab(f);
    tabs.push(tab);
    activate(tab);
    try {
      await loadDocument(tab, f.bytes);
    } catch (e) {
      closeTab(tab, true);
      fail(new Error(`${f.name}: ${e instanceof Error ? e.message : e}`));
    }
  }
}
const openPaths = async (paths: string[]) => {
  try {
    await openFiles(await Promise.all(paths.map(readPath)));
  } catch (e) {
    fail(e);
  }
};

interface Restore {
  page: number;
  scale: string;
  top: number;
  left: number;
}

async function loadDocument(tab: Tab, bytes: Uint8Array, restore?: Restore) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice(), ...PDF_ASSETS }).promise;
  const old = tab.doc;
  tab.doc = doc;
  tab.editor = tab.editor && tab.editor.source === bytes ? tab.editor : null;
  if (!restore) tab.fields = null; // structural reloads keep the model so overlays don't flicker

  const inited = new Promise<void>((res) => tab.eventBus.on("pagesinit", () => res(), { once: true }));
  tab.viewer.setDocument(doc);
  tab.linkService.setDocument(doc, null);
  await inited;
  tab.viewer.currentScaleValue = restore?.scale ?? "auto";
  if (restore) {
    tab.viewer.currentPageNumber = restore.page;
    setTimeout(() => {
      tab.container.scrollTop = restore.top;
      tab.container.scrollLeft = restore.left;
    }, 0);
  }
  void old?.destroy();
  if (tab === active) syncToolbar();
  refreshSignatures(tab, bytes);

  doc
    .getFieldObjects()
    .then((o) => {
      if (!tab.fields) tab.fieldCount = o ? Object.keys(o).length : 0; // exact count comes from pdf-lib once loaded
      if (tab === active) syncToolbar();
    })
    .catch(() => {});
  if (!restore && sideOpen && tab === active) void ensureFields(tab).then(() => renderSide());
}

function activate(tab: Tab) {
  active = tab;
  for (const t of tabs) t.host.classList.toggle("inactive", t !== tab);
  $("welcome").classList.add("gone");
  renderTabs();
  syncToolbar();
  syncZoom();
  ($("find-count") as HTMLElement).textContent = "";
  renderSigBar();
  if (sigOpen) renderSide();
  if (sideOpen) void ensureFields(tab).then(() => renderSide());
  tab.container.focus({ preventScroll: true });
}

async function closeTab(tab: Tab, force = false) {
  if (!force && tab.dirty && !(await confirmDialog(`„${tab.name}“ má neuložené zmeny. Zahodiť ich?`))) return;
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  tab.viewer.setDocument(null as never);
  void tab.doc?.destroy();
  tab.host.remove();
  if (active === tab) {
    active = null;
    const next = tabs[Math.min(i, tabs.length - 1)];
    if (next) activate(next);
  }
  if (!tabs.length) {
    $("welcome").classList.remove("gone");
    syncToolbar();
    renderSide();
    renderSigBar();
  }
  renderTabs();
}

function setDirty(tab: Tab, v: boolean) {
  if (tab.dirty === v) return;
  tab.dirty = v;
  renderTabs();
  if (tab === active) syncToolbar();
}

function renderTabs() {
  const el = $("tabs");
  el.replaceChildren(
    ...tabs.map((t) => {
      const d = document.createElement("div");
      d.className = "tab" + (t === active ? " active" : "");
      d.role = "tab";
      d.title = t.path ?? t.name;
      d.innerHTML = `<span class="title">${esc(t.name)}</span>${t.dirty ? '<span class="dot" title="Neuložené zmeny"></span>' : ""}<span class="close" title="Zavrieť (Ctrl+W)">✕</span>`;
      d.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".close")) void closeTab(t);
        else activate(t);
      });
      d.addEventListener("auxclick", (e) => e.button === 1 && void closeTab(t));
      return d;
    }),
  );
  el.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function syncToolbar() {
  const t = active;
  const has = !!t;
  for (const id of ["btn-save", "btn-saveas", "btn-prev", "btn-next", "btn-zoomin", "btn-zoomout", "btn-rotate", "btn-find", "btn-forms"]) {
    ($(id) as HTMLButtonElement).disabled = !has;
  }
  ($("btn-save") as HTMLButtonElement).disabled = !t?.dirty;
  ($("btn-undo") as HTMLButtonElement).disabled = !t?.undo.length;
  ($("btn-redo") as HTMLButtonElement).disabled = !t?.redo.length;
  $("pages").textContent = `/ ${t?.viewer.pagesCount ?? 0}`;
  ($("page") as HTMLInputElement).value = String(t?.viewer.currentPageNumber ?? 1);
  $("btn-forms").title = t && t.fieldCount ? `Formulárové polia (${t.fieldCount})` : "Formulárové polia";
  $("btn-forms").classList.toggle("active", sideOpen);
  void setWindowTitle(t ? `${t.dirty ? "● " : ""}${t.name} — PDFio` : "PDFio");
}

// ---------------------------------------------------------------- zoom / navigation

function syncZoom() {
  const t = active;
  if (!t) return;
  const sel = $("zoom") as HTMLSelectElement;
  sel.querySelector("option[data-custom]")?.remove();
  const val = String(t.viewer.currentScaleValue);
  if ([...sel.options].some((o) => o.value === val)) sel.value = val;
  else {
    const o = Object.assign(document.createElement("option"), {
      value: val,
      textContent: `${Math.round(t.viewer.currentScale * 100)} %`,
    });
    o.dataset.custom = "1";
    sel.append(o);
    sel.value = val;
  }
}

// ---------------------------------------------------------------- find

function showFindCount(c?: { current: number; total: number }, state?: number) {
  const el = $("find-count");
  if (state === 3) el.textContent = "Nenájdené"; // FindState.NOT_FOUND
  else el.textContent = c && c.total ? `${c.current} z ${c.total}` : "";
}

function doFind(again: boolean, back = false) {
  const t = active;
  if (!t) return;
  const query = ($("find-input") as HTMLInputElement).value;
  t.eventBus.dispatch("find", {
    source: window,
    type: again ? "again" : "",
    query,
    caseSensitive: ($("find-case") as HTMLInputElement).checked,
    entireWord: ($("find-word") as HTMLInputElement).checked,
    highlightAll: true,
    findPrevious: back,
    matchDiacritics: false,
    phraseSearch: true,
  });
}

function openFind() {
  $("findbar").hidden = false;
  const input = $("find-input") as HTMLInputElement;
  input.focus();
  input.select();
}
function closeFind() {
  $("findbar").hidden = true;
  active?.eventBus.dispatch("findbarclose", { source: window });
  active?.container.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- saving

async function currentBytes(tab: Tab): Promise<Uint8Array> {
  if (tab.touched && tab.doc && tab.doc.annotationStorage.size > 0) {
    // values typed into form widgets live in pdf.js' annotation storage; fold them in as one undo step
    const bytes = await tab.doc.saveDocument();
    pushUndo(tab, tab.bytes);
    tab.bytes = bytes;
    tab.touched = false;
  }
  return tab.bytes;
}

// ---------------------------------------------------------------- undo / redo

const HISTORY_MAX_STEPS = 100;
const HISTORY_MAX_BYTES = 256 * 1024 * 1024;

/** Remember `prev` (the state before a change) and drop everything that could be redone. */
function pushUndo(tab: Tab, prev: Uint8Array) {
  if (tab.undo[tab.undo.length - 1] !== prev) tab.undo.push(prev);
  tab.redo.length = 0;
  let total = tab.undo.reduce((n, b) => n + b.length, 0);
  while (tab.undo.length > HISTORY_MAX_STEPS || (total > HISTORY_MAX_BYTES && tab.undo.length > 1)) total -= tab.undo.shift()!.length;
  if (tab === active) syncToolbar();
}

function viewState(tab: Tab): Restore {
  return {
    page: tab.viewer.currentPageNumber,
    scale: String(tab.viewer.currentScaleValue),
    top: tab.container.scrollTop,
    left: tab.container.scrollLeft,
  };
}

async function stepHistory(tab: Tab, dir: "undo" | "redo") {
  try {
    await flushPending(tab);
    let done = false;
    await exclusive(tab, async () => {
      const cur = await currentBytes(tab); // folds in typed values first, so they can be undone too
      const from = dir === "undo" ? tab.undo : tab.redo;
      const to = dir === "undo" ? tab.redo : tab.undo;
      const target = from.pop();
      if (!target) return;
      to.push(cur);
      tab.bytes = target;
      tab.editor = null;
      tab.fields = null;
      await loadDocument(tab, target, viewState(tab));
      setDirty(tab, target !== tab.clean);
      done = true;
    });
    if (!done) return toast(dir === "undo" ? "Nie je čo vrátiť" : "Nie je čo zopakovať");
    await ensureFields(tab);
    if (tab.selected && !tab.fields?.some((f) => f.name === tab.selected)) tab.selected = null;
    if (tab === active) {
      renderSide();
      renderAllOverlays(tab);
      syncToolbar();
    }
  } catch (e) {
    fail(e);
  }
}

async function save(tab: Tab, saveAs = false) {
  try {
    await flushPending(tab);
    let path = tab.path;
    if (!path || saveAs) {
      path = await pickSavePath(tab.name);
      if (!path) return;
    }
    const bytes = await currentBytes(tab);
    await saveBytes(path, bytes);
    tab.path = path;
    tab.name = baseName(path);
    tab.clean = bytes;
    setDirty(tab, false);
    renderTabs();
    syncToolbar();
    toast("Uložené");
  } catch (e) {
    fail(e);
  }
}

// ---------------------------------------------------------------- forms: data

function exclusive<T>(tab: Tab, fn: () => Promise<T>): Promise<T> {
  const run = tab.queue.then(fn, fn);
  tab.queue = run.catch(() => {});
  return run;
}

async function ensureFields(tab: Tab) {
  if (tab.fields) return;
  await exclusive(tab, async () => {
    if (tab.fields) return;
    try {
      const bytes = await currentBytes(tab);
      if (!tab.editor || tab.editor.source !== bytes) tab.editor = await FormEditor.load(bytes);
      tab.fields = tab.editor.list();
      tab.fieldCount = tab.fields.length;
      tab.orphans = tab.editor.orphanCount();
    } catch (e) {
      tab.fields = [];
      fail(new Error(`Polia sa nepodarilo načítať: ${e instanceof Error ? e.message : e}`));
    }
  });
  if (tab === active) {
    syncToolbar();
    renderAllOverlays(tab);
  }
}

/** Run a structural change (add / move / edit / delete), then reload the viewer from the new bytes. */
async function applyStructural(tab: Tab, fn: (ed: FormEditor) => string | void, opts: { keepSide?: boolean } = {}) {
  // fold in edits that are already visible but not yet written, so order is preserved
  clearTimeout(tab.commitTimer);
  const pre = tab.pending.splice(0);
  const run = (ed: FormEditor) => {
    for (const op of pre) op(ed);
    return fn(ed);
  };
  try {
    await exclusive(tab, async () => {
      const flushed = await currentBytes(tab);
      if (!tab.editor || tab.editor.source !== flushed) tab.editor = await FormEditor.load(flushed);
      await tab.editor.prepare();
      const result = run(tab.editor);
      const bytes = await tab.editor.save();
      pushUndo(tab, flushed);
      tab.bytes = bytes;
      const restore = viewState(tab);
      if (typeof result === "string") tab.selected = result;
      await loadDocument(tab, bytes, restore);
      tab.editor!.source = bytes;
      // if the user kept editing meanwhile, keep the optimistic model; the next commit syncs it
      if (!tab.pending.length) {
        tab.fields = tab.editor!.list();
        tab.fieldCount = tab.fields.length;
        tab.orphans = tab.editor!.orphanCount();
      }
      setDirty(tab, true);
    });
    if (tab === active) {
      if (!opts.keepSide) renderSide();
      renderAllOverlays(tab);
    }
    if (!tab.pending.length) tab.host.classList.remove("syncing");
  } catch (e) {
    tab.editor = null;
    tab.fields = null;
    tab.host.classList.remove("syncing");
    fail(e);
    if (tab === active) void ensureFields(tab).then(() => renderSide());
  }
}

/** Queue an edit that is already reflected in the UI; written to the PDF after a short pause. */
function queueEdit(tab: Tab, op: (ed: FormEditor) => string | void, delay = 400) {
  tab.pending.push(op);
  // the real pdf.js widgets still sit at the old position until the reload; hide them meanwhile
  tab.host.classList.add("syncing");
  setDirty(tab, true);
  clearTimeout(tab.commitTimer);
  tab.commitTimer = window.setTimeout(() => void flushPending(tab), delay);
}

async function flushPending(tab: Tab) {
  if (!tab.pending.length) return;
  clearTimeout(tab.commitTimer);
  await applyStructural(tab, () => {}, { keepSide: true });
}

/** Move/resize a widget: update model + overlay + inspector inputs immediately, persist later. */
function moveLocal(tab: Tab, name: string, wi: number, rect: Rect) {
  const f = tab.fields?.find((x) => x.name === name);
  if (!f?.widgets[wi]) return;
  f.widgets[wi].rect = rect;
  renderAllOverlays(tab);
  refreshRectInputs(tab);
  queueEdit(tab, (ed) => ed.moveWidget(name, wi, rect));
}

function refreshRectInputs(tab: Tab) {
  const insp = document.querySelector<HTMLElement>(".inspector");
  const f = tab.fields?.find((x) => x.name === tab.selected);
  if (!insp || !f || insp.dataset.field !== f.name) return;
  const w = f.widgets[Math.min(tab.selectedWidget, f.widgets.length - 1)];
  insp.querySelectorAll<HTMLInputElement>("[data-rect]").forEach((i) => {
    if (i !== document.activeElement) i.value = String(Math.round(w.rect[i.dataset.rect as keyof Rect] * 100) / 100);
  });
}

// ---------------------------------------------------------------- forms: overlay on pages

function renderAllOverlays(tab: Tab) {
  for (let i = 1; i <= tab.viewer.pagesCount; i++) renderOverlay(tab, i);
}

function renderOverlay(tab: Tab, pageNumber: number) {
  const pv = tab.viewer.getPageView(pageNumber - 1);
  const div = pv?.div as HTMLDivElement | undefined;
  if (!pv || !div) return;
  div.querySelector(":scope > .field-overlay")?.remove();
  if (!sideOpen || tab !== active || !tab.fields) return;

  const vp = pv.viewport.clone({ scale: 1 });
  const ov = document.createElement("div");
  ov.className = "field-overlay" + (tab.editMode ? "" : " ro") + (tab.addType ? " adding" : "");
  const px = (n: number) => `calc(var(--total-scale-factor) * ${n}px)`;

  tab.fields.forEach((f) => {
    f.widgets.forEach((w, wi) => {
      if (w.page !== pageNumber - 1) return;
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle([w.rect.x, w.rect.y, w.rect.x + w.rect.width, w.rect.y + w.rect.height]);
      const box = document.createElement("div");
      box.className = "fbox" + (tab.selected === f.name ? " sel" : "") + (tab.selected === f.name && tab.selectedWidget === wi ? " cur" : "");
      box.style.left = px(Math.min(x1, x2));
      box.style.top = px(Math.min(y1, y2));
      box.style.width = px(Math.abs(x2 - x1));
      box.style.height = px(Math.abs(y2 - y1));
      box.dataset.name = f.name;
      box.dataset.w = String(wi);
      box.innerHTML = `<span class="lbl">${esc(f.name)}${f.type === "radio" && w.option ? ` = ${esc(w.option)}` : ""}</span>${tab.editMode ? '<span class="rz"></span>' : ""}`;
      ov.append(box);
    });
  });

  if (tab.editMode) wireOverlay(tab, ov, pageNumber - 1, pv.viewport.clone({ scale: 1 }));
  div.append(ov);
}

function viewportRectToPdf(vp: ReturnType<PDFViewer["getPageView"]>["viewport"], a: [number, number], b: [number, number]): Rect {
  const p1 = vp.convertToPdfPoint(a[0], a[1]);
  const p2 = vp.convertToPdfPoint(b[0], b[1]);
  return { x: Math.min(p1[0], p2[0]), y: Math.min(p1[1], p2[1]), width: Math.abs(p2[0] - p1[0]), height: Math.abs(p2[1] - p1[1]) };
}

function wireOverlay(tab: Tab, ov: HTMLDivElement, pageIndex: number, vp: ReturnType<PDFViewer["getPageView"]>["viewport"]) {
  const kOf = () => ov.getBoundingClientRect().width / vp.width; // css px per point

  ov.addEventListener("pointerdown", (e) => {
    const target = e.target as HTMLElement;
    const k = kOf();
    const ovRect = ov.getBoundingClientRect();

    // ---- draw a new field
    if (tab.addType && target === ov) {
      e.preventDefault();
      ov.setPointerCapture(e.pointerId);
      const sx = e.clientX - ovRect.left;
      const sy = e.clientY - ovRect.top;
      const r = document.createElement("div");
      r.className = "draw-rect";
      ov.append(r);
      const move = (m: PointerEvent) => {
        const cx = m.clientX - ovRect.left;
        const cy = m.clientY - ovRect.top;
        Object.assign(r.style, { left: `${Math.min(sx, cx)}px`, top: `${Math.min(sy, cy)}px`, width: `${Math.abs(cx - sx)}px`, height: `${Math.abs(cy - sy)}px` });
      };
      const up = (m: PointerEvent) => {
        ov.removeEventListener("pointermove", move);
        ov.removeEventListener("pointerup", up);
        r.remove();
        const cx = m.clientX - ovRect.left;
        const cy = m.clientY - ovRect.top;
        const type = tab.addType!;
        let a: [number, number] = [Math.min(sx, cx) / k, Math.min(sy, cy) / k];
        let b: [number, number] = [Math.max(sx, cx) / k, Math.max(sy, cy) / k];
        if (b[0] - a[0] < 6 || b[1] - a[1] < 6) {
          const [w, h] = type === "checkbox" || type === "radio" ? [16, 16] : type === "list" ? [140, 60] : [140, 22];
          a = [sx / k, sy / k];
          b = [a[0] + w, a[1] + h];
        }
        const rect = viewportRectToPdf(vp, a, b);
        tab.addType = null;
        void applyStructural(tab, (ed) => ed.add(type as AddType, pageIndex, rect));
      };
      ov.addEventListener("pointermove", move);
      ov.addEventListener("pointerup", up);
      return;
    }

    // ---- move / resize an existing widget
    const box = target.closest(".fbox") as HTMLDivElement | null;
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    const name = box.dataset.name!;
    const wi = Number(box.dataset.w);
    const field = tab.fields?.find((f) => f.name === name);
    if (!field) return;
    if (tab.selected !== name || tab.selectedWidget !== wi) {
      tab.selected = name;
      tab.selectedWidget = wi;
      ov.parentElement?.querySelectorAll(".fbox.sel").forEach((x) => x.classList.remove("sel"));
      box.classList.add("sel");
      box.querySelector(".rz") || box.insertAdjacentHTML("beforeend", '<span class="rz"></span>');
      renderSide();
    }

    const resizing = target.classList.contains("rz");
    const w = field.widgets[wi];
    const [vx1, vy1, vx2, vy2] = vp.convertToViewportRectangle([w.rect.x, w.rect.y, w.rect.x + w.rect.width, w.rect.y + w.rect.height]);
    const start = { x: e.clientX, y: e.clientY, l: box.offsetLeft, t: box.offsetTop, w: box.offsetWidth, h: box.offsetHeight };
    let moved = false;
    box.setPointerCapture(e.pointerId);

    const move = (m: PointerEvent) => {
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      if (resizing) {
        box.style.width = `${Math.max(6, start.w + dx)}px`;
        box.style.height = `${Math.max(6, start.h + dy)}px`;
      } else {
        box.style.left = `${start.l + dx}px`;
        box.style.top = `${start.t + dy}px`;
      }
    };
    const up = (m: PointerEvent) => {
      box.removeEventListener("pointermove", move);
      box.removeEventListener("pointerup", up);
      if (!moved) return;
      const dx = (m.clientX - start.x) / k;
      const dy = (m.clientY - start.y) / k;
      const a: [number, number] = resizing ? [Math.min(vx1, vx2), Math.min(vy1, vy2)] : [vx1 + dx, vy1 + dy];
      const b: [number, number] = resizing
        ? [Math.max(Math.max(vx1, vx2) + dx, a[0] + 6), Math.max(Math.max(vy1, vy2) + dy, a[1] + 6)]
        : [vx2 + dx, vy2 + dy];
      const rect = viewportRectToPdf(vp, a, b);
      moveLocal(tab, name, wi, rect);
    };
    box.addEventListener("pointermove", move);
    box.addEventListener("pointerup", up);
  });
}

// ---------------------------------------------------------------- forms: side panel

function selectField(tab: Tab, name: string, scroll: boolean) {
  tab.selected = name;
  tab.selectedWidget = 0;
  renderSide();
  renderAllOverlays(tab);
  const f = tab.fields?.find((x) => x.name === name);
  const w = f?.widgets[0];
  if (scroll && w && w.page >= 0) {
    tab.viewer.scrollPageIntoView({
      pageNumber: w.page + 1,
      destArray: [null, { name: "XYZ" }, Math.max(0, w.rect.x - 30), w.rect.y + w.rect.height + 80, null],
    });
  }
}

/** In-app clipboard for Ctrl+C / Ctrl+V on form fields. */
let fieldClip: { tab: Tab; name: string } | null = null;

function highlightField(tab: Tab | null, name: string | null) {
  if (!tab) return;
  tab.container.querySelectorAll(".fbox.hl").forEach((b) => b.classList.remove("hl"));
  if (name === null) return;
  tab.container.querySelectorAll<HTMLElement>(".fbox").forEach((b) => {
    if (b.dataset.name === name) b.classList.add("hl");
  });
}

function renderSide() {
  const side = $("side");
  side.hidden = !sideOpen && !sigOpen;
  $("btn-forms").classList.toggle("active", sideOpen);
  $("sigbar").querySelector("[data-act=sigpanel]")?.classList.toggle("active", sigOpen);
  const tab = active;
  if (sigOpen && tab) return renderSigPanel(tab);
  if (!sideOpen || !tab) {
    side.replaceChildren();
    return;
  }
  const fields = tab.fields;
  const edit = tab.editMode;
  const sel = fields?.find((f) => f.name === tab.selected) ?? null;

  const addTypes: [AddType, string][] = [
    ["text", "Text"],
    ["checkbox", "Zaškrtávacie"],
    ["radio", "Radio"],
    ["dropdown", "Rozbaľovací"],
    ["list", "Zoznam"],
    ["button", "Tlačidlo"],
    ["signature", "Podpis"],
  ];

  side.innerHTML = `
    <div class="side-head">
      <h3>Formulárové polia${fields ? ` (${fields.length})` : ""}</h3>
      <label title="Povoliť pridávanie, presúvanie a úpravu polí"><input type="checkbox" id="edit-toggle" ${edit ? "checked" : ""}/> Režim úprav</label>
    </div>
    ${
      edit
        ? `<div class="add-tools"><span class="hint">${
            tab.addType ? `Ťahaj myšou po strane a nakresli pole (${FIELD_TYPE_LABEL[tab.addType]}). Esc = zrušiť.` : "Pridať pole:"
          }</span>${addTypes
            .map(([t, l]) => `<button data-add="${t}" class="${tab.addType === t ? "active" : ""}">${l}</button>`)
            .join("")}</div>`
        : ""
    }
    ${
      tab.orphans
        ? `<div class="warn">V dokumente je ${tab.orphans} osirotených widgetov (duplikáty polí, ktoré nie sú vo formulári). Zobrazujú sa ako „tieň“ na pôvodnej pozícii.${
            edit ? ' <button data-act="clean">Vyčistiť</button>' : " Zapni režim úprav a vyčisti ich."
          }</div>`
        : ""
    }
    <div class="fields">${
      !fields
        ? '<div class="empty">Načítavam…</div>'
        : fields.length
          ? fields
              .map(
                (f) =>
                  `<div class="frow${f.name === tab.selected ? " sel" : ""}" data-name="${esc(f.name)}"><span class="n" title="${esc(f.name)}">${esc(f.name)}</span><span class="badge">${FIELD_TYPE_LABEL[f.type]}</span><span class="badge">str. ${(f.widgets[0]?.page ?? -1) + 1}</span></div>`,
              )
              .join("")
          : '<div class="empty">Dokument neobsahuje formulárové polia.' + (edit ? " Pridaj ich tlačidlami vyššie." : " Zapni režim úprav a pridaj nové.") + "</div>"
    }</div>
    ${sel ? inspectorHtml(tab, sel, !edit) : ""}`;
}

/** Radio group: one row per button (own export value, position, size - the selected row's geometry is edited below). */
function radioButtonsHtml(tab: Tab, f: FieldInfo, ro: boolean): string {
  const cur = Math.min(tab.selectedWidget, f.widgets.length - 1);
  const rows = f.widgets
    .map(
      (x, i) => `<div class="rb${i === cur ? " cur" : ""}">
        <button class="icon" data-wsel="${i}" title="Vybrať toto tlačidlo (zobrazí jeho pozíciu a veľkosť)">${i === cur ? "◉" : "○"}</button>
        <input type="text" data-k="wopt" data-w="${i}" value="${esc(x.option ?? "")}" placeholder="hodnota" ${ro || x.option === undefined ? "disabled" : ""}/>
        <span class="badge">str. ${x.page + 1}</span>
        ${ro ? "" : `<button class="icon danger" data-act="delwidget" data-w="${i}" title="Odstrániť toto tlačidlo">✕</button>`}
      </div>`,
    )
    .join("");
  return `<div class="rbs"><div class="rbs-head"><span>Tlačidlá skupiny (${f.widgets.length})</span>${
    ro ? "" : '<button data-act="addopt">+ Pridať tlačidlo</button>'
  }</div>${rows}</div>`;
}

function inspectorHtml(tab: Tab, f: FieldInfo, ro: boolean): string {
  const d = ro ? "disabled" : "";
  const w = f.widgets[Math.min(tab.selectedWidget, f.widgets.length - 1)];
  const row = (label: string, inner: string) => `<div class="row"><label>${label}</label><div>${inner}</div></div>`;
  const chk = (k: string, v: boolean) => `<input type="checkbox" data-k="${k}" ${v ? "checked" : ""} ${d}/>`;

  let valueCtl = "";
  if (f.type === "text")
    valueCtl = f.multiline
      ? `<textarea data-k="value" rows="3" ${d}>${esc(f.value)}</textarea>`
      : `<input type="text" data-k="value" value="${esc(f.value)}" ${d}/>`;
  else if (f.type === "checkbox") valueCtl = chk("value", f.value === "true");
  else if (f.type === "radio" || f.type === "dropdown" || f.type === "list")
    valueCtl = `<select data-k="value" ${d}><option value=""></option>${f.options
      .map((o) => `<option value="${esc(o)}" ${f.value.split("\n").includes(o) ? "selected" : ""}>${esc(o)}</option>`)
      .join("")}</select>`;

  return `<div class="inspector" data-field="${esc(f.name)}">
    ${ro ? '<div class="empty" style="padding:0 0 6px">Len na čítanie – zapni „Režim úprav“ pre zmeny.</div>' : ""}
    ${row("Názov", `<input type="text" data-k="name" value="${esc(f.partialName)}" ${d}/>`)}
    ${f.name !== f.partialName ? row("Plný názov", `<span title="${esc(f.name)}">${esc(f.name)}</span>`) : ""}
    ${row("Typ", esc(FIELD_TYPE_LABEL[f.type]))}
    ${row("Strana", String((w?.page ?? -1) + 1))}
    ${row("Tooltip", `<input type="text" data-k="tooltip" value="${esc(f.tooltip)}" ${d}/>`)}
    ${valueCtl ? row("Hodnota", valueCtl) : ""}
    ${f.type === "dropdown" || f.type === "list" ? row("Možnosti", `<textarea data-k="options" rows="3" ${d}>${esc(f.options.join("\n"))}</textarea>`) : ""}
    ${row("Povinné", chk("required", f.required))}
    ${row("Len na čítanie", chk("readOnly", f.readOnly))}
    ${f.type === "text" ? row("Viacriadkové", chk("multiline", f.multiline)) : ""}
    ${f.type === "text" ? row("Max. dĺžka", `<input type="number" min="0" data-k="maxLength" value="${f.maxLength ?? ""}" ${d}/>`) : ""}
    ${f.fontSize !== null ? row("Písmo (pt)", `<input type="number" min="0" step="1" data-k="fontSize" value="${f.fontSize}" title="0 = automaticky" ${d}/>`) : ""}
    ${f.type === "radio" ? radioButtonsHtml(tab, f, ro) : ""}
    ${
      f.widgets.length > 1 && f.type !== "radio"
        ? row("Widget", `<select data-k="widget">${f.widgets.map((x, i) => `<option value="${i}" ${i === tab.selectedWidget ? "selected" : ""}>${i + 1}${x.option ? ` – ${esc(x.option)}` : ""} (str. ${x.page + 1})</option>`).join("")}</select>`)
        : ""
    }
    ${
      w
        ? `<div class="row"><label>Pozícia</label><div class="rect">
            ${(["x", "y", "width", "height"] as const)
              .map((k) => `<label>${{ x: "X", y: "Y", width: "Šírka", height: "Výška" }[k]}<input type="number" step="1" data-rect="${k}" value="${Math.round(w.rect[k] * 100) / 100}" ${d}/></label>`)
              .join("")}
          </div></div>`
        : ""
    }
    ${ro ? "" : '<div class="actions"><button data-act="clone" title="Vytvorí kópiu poľa (meno_1, meno_2, …) hneď vedľa originálu">Klonovať pole</button><button class="danger" data-act="delete">Vymazať pole</button></div>'}
  </div>`;
}

function onSideChange(e: Event) {
  const tab = active;
  const el = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (!tab) return;

  if (el.id === "edit-toggle") {
    tab.editMode = (el as HTMLInputElement).checked;
    tab.addType = null;
    renderSide();
    renderAllOverlays(tab);
    return;
  }
  const insp = el.closest(".inspector") as HTMLElement | null;
  if (!insp) return;
  const name = insp.dataset.field!;
  const field = tab.fields?.find((f) => f.name === name);
  if (!field) return;

  if (el.dataset.k === "widget") {
    tab.selectedWidget = Number(el.value);
    renderSide();
    renderAllOverlays(tab);
    return;
  }
  if (el.dataset.rect) {
    // handled live in onSideInput (keeps focus, no re-render)
    return;
  }
  const k = el.dataset.k;
  if (!k) return;
  if (k === "wopt") {
    const wi = Number(el.dataset.w);
    tab.selectedWidget = wi;
    void applyStructural(tab, (ed) => ed.setWidgetOption(name, wi, el.value.trim()));
    return;
  }
  const patch: FieldPatch = {};
  const isCheck = (el as HTMLInputElement).type === "checkbox";
  switch (k) {
    case "name":
      patch.name = el.value.trim();
      break;
    case "tooltip":
      patch.tooltip = el.value;
      break;
    case "value":
      patch.value = isCheck ? String((el as HTMLInputElement).checked) : el.value;
      break;
    case "options":
      patch.options = el.value.split("\n").map((s) => s.trim()).filter(Boolean);
      break;
    case "required":
    case "readOnly":
    case "multiline":
      patch[k] = (el as HTMLInputElement).checked;
      break;
    case "maxLength":
      patch.maxLength = el.value ? Number(el.value) : null;
      break;
    case "fontSize":
      patch.fontSize = Number(el.value) || 0;
      break;
  }
  void applyStructural(tab, (ed) => ed.update(name, patch));
}

/** Live coordinate editing: fires on typing and on arrow-key / spinner steps, never steals focus. */
function onSideInput(e: Event) {
  const tab = active;
  const el = e.target as HTMLInputElement;
  if (!tab || !el.dataset.rect) return;
  const insp = el.closest(".inspector") as HTMLElement | null;
  const field = tab.fields?.find((f) => f.name === insp?.dataset.field);
  if (!insp || !field) return;
  const val = (k: string) => (insp.querySelector(`[data-rect="${k}"]`) as HTMLInputElement).value;
  if (["x", "y", "width", "height"].some((k) => val(k).trim() === "" || Number.isNaN(Number(val(k))))) return;
  const wi = Math.min(tab.selectedWidget, field.widgets.length - 1);
  moveLocal(tab, field.name, wi, {
    x: Number(val("x")),
    y: Number(val("y")),
    width: Math.max(1, Number(val("width"))),
    height: Math.max(1, Number(val("height"))),
  });
}

function onSideClick(e: MouseEvent) {
  const tab = active;
  if (!tab) return;
  const t = e.target as HTMLElement;
  if (sigOpen) {
    if (t.closest("[data-act=sigclose]")) return void toggleSigPanel(false);
    if (t.closest("details")) return;
    const card = t.closest<HTMLElement>(".sig");
    if (card) selectSig(tab, Number(card.dataset.sig), true);
    return;
  }
  const row = t.closest<HTMLElement>(".frow");
  if (row) return selectField(tab, row.dataset.name!, true);

  const add = t.closest<HTMLElement>("[data-add]");
  if (add) {
    const type = add.dataset.add as AddType;
    tab.addType = tab.addType === type ? null : type;
    renderSide();
    renderAllOverlays(tab);
    return;
  }
  if (t.closest("[data-act=clean]")) {
    void applyStructural(tab, (ed) => {
      toast(`Odstránených widgetov: ${ed.removeOrphans()}`);
    });
    return;
  }
  const wsel = t.closest<HTMLElement>("[data-wsel]");
  if (wsel) {
    tab.selectedWidget = Number(wsel.dataset.wsel);
    renderSide();
    renderAllOverlays(tab);
    return;
  }
  if (t.closest("[data-act=addopt]") && tab.selected) {
    const name = tab.selected;
    const f = tab.fields?.find((x) => x.name === name);
    if (!f) return;
    const after = Math.min(tab.selectedWidget, f.widgets.length - 1);
    tab.selectedWidget = f.widgets.length; // the new button becomes the last widget and gets selected
    void applyStructural(tab, (ed) => {
      ed.addRadioOption(name, after);
    });
    return;
  }
  if (t.closest("[data-act=clone]") && tab.selected) {
    const name = tab.selected;
    tab.selectedWidget = 0;
    void applyStructural(tab, (ed) => ed.clone(name));
    return;
  }
  const delw = t.closest<HTMLElement>("[data-act=delwidget]");
  if (delw && tab.selected) {
    const name = tab.selected;
    const wi = Number(delw.dataset.w);
    tab.selectedWidget = 0;
    void applyStructural(tab, (ed) => ed.removeWidget(name, wi));
    return;
  }
  if (t.closest("[data-act=delete]") && tab.selected) {
    const name = tab.selected;
    tab.selected = null;
    void applyStructural(tab, (ed) => ed.remove(name));
  }
}

async function toggleSide() {
  sideOpen = !sideOpen;
  sigOpen = false;
  const t = active;
  if (sideOpen && t) await ensureFields(t);
  renderSide();
  for (const x of tabs) renderAllOverlays(x);
}

// ---------------------------------------------------------------- digital signatures

const SIG_ICON: Record<SigStatus, string> = { valid: "✓", warn: "!", invalid: "✕", unknown: "?", pending: "…" };

/** (Re)verify signatures for the bytes now shown in the tab; stale results are dropped. */
function refreshSignatures(tab: Tab, bytes: Uint8Array) {
  if (tab.sigSource === bytes) return;
  tab.sigSource = bytes;
  void analyzeSignatures(bytes, (sigs) => {
    if (tab.sigSource !== bytes) return;
    tab.sigs = sigs;
    if (tab.selectedSig !== null && tab.selectedSig >= sigs.length) tab.selectedSig = null;
    if (tab !== active) return;
    renderSigBar();
    if (sigOpen) renderSide();
    for (let i = 1; i <= tab.viewer.pagesCount; i++) renderSigOverlay(tab, i);
  }).catch((e) => {
    console.error(e);
    if (tab.sigSource === bytes) tab.sigs = [];
  });
}

function overallText(sigs: SigInfo[]): string {
  const n = sigs.length;
  const what = `${n} ${n < 5 ? "podpisy" : "podpisov"}`;
  if (n === 1) return `${sigs[0].summary}.`;
  switch (overallStatus(sigs)) {
    case "valid":
      return `Dokument obsahuje ${what}, všetky sú platné.`;
    case "pending":
      return `Dokument obsahuje ${what}, overujem certifikáty…`;
    case "invalid":
      return `Dokument obsahuje ${what}, aspoň jeden je NEPLATNÝ.`;
    case "unknown":
      return `Dokument obsahuje ${what}, platnosť niektorých sa nepodarilo overiť.`;
    default:
      return `Dokument obsahuje ${what}, niektoré majú výhrady.`;
  }
}

function renderSigBar() {
  const bar = $("sigbar");
  const sigs = active?.sigs;
  if (!sigs?.length) {
    bar.hidden = true;
    return;
  }
  const st = overallStatus(sigs);
  bar.hidden = false;
  bar.className = `st-${st}`;
  bar.innerHTML = `<span class="sig-ic st-${st}">${SIG_ICON[st]}</span><span class="txt">${esc(overallText(sigs))}</span><button data-act="sigpanel" class="${sigOpen ? "active" : ""}">Panel podpisov</button>`;
}

function toggleSigPanel(open = !sigOpen) {
  sigOpen = open;
  if (open && sideOpen) {
    sideOpen = false;
    for (const t of tabs) renderAllOverlays(t);
  }
  renderSide();
  renderSigBar();
}

function selectSig(tab: Tab, i: number, scroll: boolean) {
  tab.selectedSig = i;
  if (!sigOpen) toggleSigPanel(true);
  else renderSide();
  for (let p = 1; p <= tab.viewer.pagesCount; p++) renderSigOverlay(tab, p);
  const w = tab.sigs?.[i]?.widget;
  if (scroll && w) {
    tab.viewer.scrollPageIntoView({
      pageNumber: w.page + 1,
      destArray: [null, { name: "XYZ" }, Math.max(0, w.rect.x - 30), w.rect.y + w.rect.height + 80, null],
    });
  }
}

function highlightSig(tab: Tab | null, idx: string | null) {
  if (!tab) return;
  tab.container.querySelectorAll(".sigmark.hl").forEach((b) => b.classList.remove("hl"));
  if (idx === null) return;
  tab.container.querySelectorAll<HTMLElement>(`.sigmark[data-sig="${idx}"]`).forEach((b) => b.classList.add("hl"));
}

/** Status badge on each visible signature widget (always shown, independent of the side panel). */
function renderSigOverlay(tab: Tab, pageNumber: number) {
  const pv = tab.viewer.getPageView(pageNumber - 1);
  const div = pv?.div as HTMLDivElement | undefined;
  if (!pv || !div) return;
  div.querySelector(":scope > .sig-overlay")?.remove();
  const sigs = tab.sigs?.filter((s) => s.widget?.page === pageNumber - 1 && s.widget.rect.width > 1 && s.widget.rect.height > 1);
  if (!sigs?.length) return;
  const vp = pv.viewport.clone({ scale: 1 });
  const px = (n: number) => `calc(var(--total-scale-factor) * ${n}px)`;
  const ov = document.createElement("div");
  ov.className = "sig-overlay";
  for (const s of sigs) {
    const r = s.widget!.rect;
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle([r.x, r.y, r.x + r.width, r.y + r.height]);
    const m = document.createElement("div");
    m.className = `sigmark st-${s.status}` + (tab.selectedSig === s.index ? " sel" : "");
    m.dataset.sig = String(s.index);
    Object.assign(m.style, { left: px(Math.min(x1, x2)), top: px(Math.min(y1, y2)), width: px(Math.abs(x2 - x1)), height: px(Math.abs(y2 - y1)) });
    const ic = document.createElement("span");
    ic.className = `sig-ic st-${s.status}`;
    ic.textContent = SIG_ICON[s.status];
    ic.title = [s.summary, s.signer?.name, "Klik = podrobnosti"].filter(Boolean).join("\n");
    ic.addEventListener("click", (e) => {
      e.stopPropagation();
      selectSig(tab, s.index, false);
    });
    m.append(ic);
    ov.append(m);
  }
  div.append(ov);
}

function sigCardHtml(tab: Tab, s: SigInfo): string {
  const row = (label: string, v: string) => (v ? `<div class="row"><label>${label}</label><div>${v}</div></div>` : "");
  const timeSrc = { timestamp: "podľa časovej pečiatky", "signed-attr": "podľa hodín zariadenia podpisovateľa", dict: "podľa hodín zariadenia podpisovateľa" } as const;
  const c = s.signer;
  const title = s.docTimestamp ? `Časová pečiatka${c ? ` – ${c.name}` : ""}` : c?.name || s.name || "Neznámy podpisovateľ";
  const checks = s.checks.map((k) => `<li class="${k.ok === true ? "ok" : k.ok === false ? "bad" : "info"}">${esc(k.text)}</li>`).join("");
  return `<div class="sig${tab.selectedSig === s.index ? " sel" : ""}" data-sig="${s.index}"${s.fieldName ? ` data-name="${esc(s.fieldName)}"` : ""}>
    <div class="sig-head"><span class="sig-ic st-${s.status}">${SIG_ICON[s.status]}</span><div><div class="who">${esc(title)}</div><div class="sum st-${s.status}">${esc(s.summary)}</div></div></div>
    ${row("Podpísané", s.time ? `${esc(fmtDate(s.time))}${s.timeSource ? `<div class="sub">${timeSrc[s.timeSource]}</div>` : ""}` : "")}
    ${row("Organizácia", esc(c?.org ?? ""))}
    ${row("Dôvod", esc(s.reason))}
    ${row("Miesto", esc(s.location))}
    ${row("Kontakt", esc(s.contact || c?.email || ""))}
    ${row("Pole", s.fieldName ? `${esc(s.fieldName)}${s.widget ? ` <span class="badge">str. ${s.widget.page + 1}</span>` : ""}` : "")}
    <ul class="checks">${checks}</ul>
    <details><summary>Podrobnosti</summary>
      ${row("Podpisovateľ", esc(c?.name ?? "–"))}
      ${row("Vydavateľ", esc(c?.issuer ?? ""))}
      ${row("Platnosť cert.", c ? `${esc(fmtDate(c.notBefore))} – ${esc(fmtDate(c.notAfter))}` : "")}
      ${row("Sériové č.", c ? `<span class="mono">${esc(c.serial)}</span>` : "")}
      ${row("Reťazec", s.chain.length ? s.chain.map((x) => esc(x)).join("<br>↳ ") : "")}
      ${row("Časová pečiatka", esc(s.tsa ?? ""))}
      ${row("Formát", esc(s.subFilter))}
      ${row("Hash", esc(s.digestAlg))}
      ${row("Revízia", `${s.revision} z ${tab.sigs?.length ?? 0}${s.coversWholeFile ? " (pokrýva celý súbor)" : ""}`)}
    </details>
  </div>`;
}

function renderSigPanel(tab: Tab) {
  const sigs = tab.sigs;
  $("side").innerHTML = `
    <div class="side-head"><h3>Podpisy${sigs ? ` (${sigs.length})` : ""}</h3><button class="icon" data-act="sigclose" title="Zavrieť">✕</button></div>
    <div class="sigs">${
      !sigs ? '<div class="empty">Overujem…</div>' : sigs.length ? sigs.map((s) => sigCardHtml(tab, s)).join("") : '<div class="empty">Dokument nie je digitálne podpísaný.</div>'
    }</div>
    ${
      sigs?.length
        ? '<div class="sig-note">Integrita sa overuje kryptograficky, dôveryhodnosť certifikátu voči úložisku certifikátov Windows (vrátane kontroly zrušenia, ak je dostupná).</div>'
        : ""
    }`;
}

// ---------------------------------------------------------------- wiring

function bindUi() {
  $("btn-newtab").onclick = async () => {
    try {
      await openFiles(await pickFiles());
    } catch (e) {
      fail(e);
    }
  };
  $("btn-undo").onclick = () => active && void stepHistory(active, "undo");
  $("btn-redo").onclick = () => active && void stepHistory(active, "redo");
  $("btn-save").onclick = () => active && void save(active);
  $("btn-saveas").onclick = () => active && void save(active, true);
  $("btn-zoomin").onclick = () => active?.viewer.increaseScale({ steps: 1 });
  $("btn-zoomout").onclick = () => active?.viewer.decreaseScale({ steps: 1 });
  $("zoom").onchange = (e) => {
    if (active) active.viewer.currentScaleValue = (e.target as HTMLSelectElement).value;
  };
  $("btn-prev").onclick = () => active?.viewer.previousPage();
  $("btn-next").onclick = () => active?.viewer.nextPage();
  $("page").onchange = (e) => {
    if (active) active.viewer.currentPageNumber = Number((e.target as HTMLInputElement).value) || 1;
  };
  $("btn-rotate").onclick = () => {
    if (active) active.viewer.pagesRotation = (active.viewer.pagesRotation + 90) % 360;
  };
  $("btn-find").onclick = openFind;
  $("find-close").onclick = closeFind;
  $("find-next").onclick = () => doFind(true, false);
  $("find-prev").onclick = () => doFind(true, true);
  $("find-input").oninput = () => doFind(false);
  $("find-case").onchange = $("find-word").onchange = () => doFind(false);
  $("find-input").onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doFind(true, e.shiftKey);
    }
  };
  $("btn-forms").onclick = () => void toggleSide();
  $("sigbar").onclick = (e) => {
    if ((e.target as HTMLElement).closest("[data-act=sigpanel]")) toggleSigPanel();
  };

  $("btn-theme").onclick = () => applyTheme(({ auto: "light", light: "dark", dark: "auto" } as const)[getTheme()]);
  const invert = () => {
    let on = false;
    try {
      on = localStorage.getItem("invert") === "1";
    } catch {}
    return on;
  };
  const setInvert = (on: boolean) => {
    $("viewers").classList.toggle("invert-pages", on);
    $("btn-invert").classList.toggle("active", on);
    try {
      localStorage.setItem("invert", on ? "1" : "0");
    } catch {}
  };
  setInvert(invert());
  $("btn-invert").onclick = () => setInvert(!invert());

  $("side").addEventListener("change", onSideChange);
  $("side").addEventListener("input", onSideInput);
  $("side").addEventListener("click", onSideClick);
  // hovering a field in the list highlights it in the document
  $("side").addEventListener("mouseover", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".frow, .sig");
    highlightField(active, row?.dataset.name ?? null);
    highlightSig(active, row?.dataset.sig ?? null);
  });
  $("side").addEventListener("mouseleave", () => {
    highlightField(active, null);
    highlightSig(active, null);
  });

  new ResizeObserver(() => {
    for (const t of tabs) {
      const v = String(t.viewer.currentScaleValue);
      if (t.doc && Number.isNaN(Number(v))) t.viewer.currentScaleValue = v; // auto / page-fit / page-width
    }
  }).observe($("viewers"));

  window.addEventListener("keydown", (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === "F5" || (ctrl && key === "r")) return e.preventDefault();
    if (ctrl && key === "o") { e.preventDefault(); return $("btn-newtab").click(); }
    const typing = /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement).tagName) && !/^(checkbox|radio|button)$/.test((e.target as HTMLInputElement).type);
    if (ctrl && !typing && active && (key === "z" || key === "y")) {
      e.preventDefault();
      return void stepHistory(active, key === "y" || e.shiftKey ? "redo" : "undo");
    }
    if (ctrl && key === "s") { e.preventDefault(); return void (active && save(active, e.shiftKey)); }
    if (ctrl && key === "w") { e.preventDefault(); return void (active && closeTab(active)); }
    if (ctrl && key === "f") { e.preventDefault(); return openFind(); }
    if (ctrl && key === "p") { e.preventDefault(); return toast("Tlač zatiaľ nie je podporovaná"); }
    if (ctrl && e.key === "Tab") {
      e.preventDefault();
      if (tabs.length > 1 && active) activate(tabs[(tabs.indexOf(active) + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]);
      return;
    }
    if (ctrl && (e.key === "+" || e.key === "=")) { e.preventDefault(); return active?.viewer.increaseScale({ steps: 1 }); }
    if (ctrl && (e.key === "-" || e.key === "_")) { e.preventDefault(); return active?.viewer.decreaseScale({ steps: 1 }); }
    if (ctrl && e.key === "0") { e.preventDefault(); if (active) active.viewer.currentScaleValue = "1"; return; }
    if (e.key === "Escape") {
      if (active?.addType) {
        active.addType = null;
        renderSide();
        renderAllOverlays(active);
      } else if (!$("findbar").hidden) closeFind();
      return;
    }
    // Ctrl+C / Ctrl+V on a selected field = clone it; leaves normal text copy alone (text selected, or typing in an input)
    if (ctrl && (key === "c" || key === "v") && !inField && sideOpen && active?.editMode && !window.getSelection()?.toString()) {
      const tab = active;
      if (key === "c" && tab.selected) {
        fieldClip = { tab, name: tab.selected };
        e.preventDefault();
        return toast(`Pole „${tab.selected}“ skopírované – Ctrl+V vloží kópiu`);
      }
      if (key === "v" && fieldClip) {
        e.preventDefault();
        const src = fieldClip;
        if (src.tab !== tab) return toast("Vloženie poľa do iného dokumentu zatiaľ nie je podporované");
        if (!tab.fields?.some((f) => f.name === src.name)) return toast("Skopírované pole už neexistuje");
        tab.selectedWidget = 0;
        return void applyStructural(tab, (ed) => ed.clone(src.name));
      }
    }
    if (e.key === "Delete" && !inField && active?.editMode && active.selected) {
      const name = active.selected;
      active.selected = null;
      void applyStructural(active, (ed) => ed.remove(name));
    }
  });
}

async function main() {
  applyTheme(getTheme());
  bindUi();
  if (isTauri) {
    document.body.classList.add("native");
    $("win-min").onclick = () => windowControl("minimize");
    $("win-max").onclick = () => windowControl("toggleMaximize");
    $("win-close").onclick = () => windowControl("close");
    void onWindowMaximized((m) => {
      document.body.classList.toggle("maxed", m);
      $("win-max").title = m ? "Obnoviť" : "Maximalizovať";
    });
  }
  syncToolbar();
  await showWindow();
  await wireNative({
    onFiles: (paths) => void openPaths(paths),
    onBrowserFiles: async (files) => openFiles(await filesToOpened(files.filter((f) => /\.pdf$/i.test(f.name)))),
    canClose: async () => !tabs.some((t) => t.dirty) || confirmDialog("Niektoré dokumenty majú neuložené zmeny. Zahodiť ich a zavrieť?"),
  });
  // handy for manual testing in the browser: window.__pdfio.open(file)
  (window as unknown as { __pdfio: unknown }).__pdfio = { openFiles };
}

main().catch(fail);
