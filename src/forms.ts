// AcroForm editing on top of pdf-lib: list fields + metadata, add / move / resize / rename / delete.
import {
  PDFArray,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFString,
  PDFTextField,
  PDFWidgetAnnotation,
  StandardFonts,
  rgb,
} from "pdf-lib";

export type FieldType = "text" | "checkbox" | "radio" | "dropdown" | "list" | "button" | "signature" | "unknown";

/** Rect in PDF user space (points, origin bottom-left). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WidgetInfo {
  page: number; // 0-based, -1 when unknown
  rect: Rect;
  option?: string; // radio: the export value of this button
}

export interface FieldInfo {
  name: string; // fully qualified
  partialName: string;
  type: FieldType;
  tooltip: string;
  required: boolean;
  readOnly: boolean;
  value: string; // checkbox: "true" | "false"; list: values joined by \n
  options: string[];
  multiline: boolean;
  maxLength: number | null;
  fontSize: number | null; // null = not applicable, 0 = auto
  widgets: WidgetInfo[];
}

export interface FieldPatch {
  name?: string; // new partial name
  tooltip?: string;
  required?: boolean;
  readOnly?: boolean;
  value?: string;
  options?: string[];
  multiline?: boolean;
  maxLength?: number | null;
  fontSize?: number;
}

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "Text",
  checkbox: "Zaškrtávacie",
  radio: "Radio",
  dropdown: "Rozbaľovací zoznam",
  list: "Zoznam",
  button: "Tlačidlo",
  signature: "Podpis",
  unknown: "Neznáme",
};

function typeOf(f: PDFField): FieldType {
  if (f instanceof PDFTextField) return "text";
  if (f instanceof PDFCheckBox) return "checkbox";
  if (f instanceof PDFRadioGroup) return "radio";
  if (f instanceof PDFDropdown) return "dropdown";
  if (f instanceof PDFOptionList) return "list";
  if (f instanceof PDFButton) return "button";
  if (f instanceof PDFSignature) return "signature";
  return "unknown";
}

function decode(o: unknown): string {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  return "";
}

export class FormEditor {
  private constructor(
    public doc: PDFDocument,
    /** the byte array this editor currently mirrors */
    public source: Uint8Array,
  ) {}

  static async load(bytes: Uint8Array): Promise<FormEditor> {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return new FormEditor(doc, bytes);
  }

  get pageCount() {
    return this.doc.getPageCount();
  }

  pageSize(i: number) {
    return this.doc.getPage(i).getSize();
  }

  // ---------- reading ----------

  list(): FieldInfo[] {
    const form = this.doc.getForm();
    const pageIndexByRef = new Map<string, number>();
    this.doc.getPages().forEach((p, i) => pageIndexByRef.set(p.ref.toString(), i));
    let annotOwner: Map<string, number> | null = null;
    const ownerOf = (ref: PDFRef | undefined) => {
      if (!ref) return -1;
      if (!annotOwner) {
        annotOwner = new Map();
        this.doc.getPages().forEach((p, i) => {
          const annots = p.node.Annots();
          annots?.asArray().forEach((a) => a instanceof PDFRef && annotOwner!.set(a.toString(), i));
        });
      }
      return annotOwner.get(ref.toString()) ?? -1;
    };

    return form.getFields().map((f): FieldInfo => {
      const type = typeOf(f);
      const widgets: WidgetInfo[] = f.acroField.getWidgets().map((w) => {
        const pRef = w.P();
        const wRef = this.doc.context.getObjectRef(w.dict);
        let page = pRef instanceof PDFRef ? (pageIndexByRef.get(pRef.toString()) ?? -1) : -1;
        if (page < 0) page = ownerOf(wRef);
        let option: string | undefined;
        if (type === "radio") option = this.radioOption(f as PDFRadioGroup, w);
        return { page, rect: w.getRectangle(), option };
      });

      let value = "";
      let options: string[] = [];
      let multiline = false;
      let maxLength: number | null = null;
      let fontSize: number | null = null;
      try {
        if (f instanceof PDFTextField) {
          value = f.getText() ?? "";
          multiline = f.isMultiline();
          maxLength = f.getMaxLength() ?? null;
          fontSize = this.fontSizeOf(f);
        } else if (f instanceof PDFCheckBox) {
          value = String(f.isChecked());
        } else if (f instanceof PDFRadioGroup) {
          value = f.getSelected() ?? "";
          options = f.getOptions();
        } else if (f instanceof PDFDropdown) {
          value = f.getSelected()[0] ?? "";
          options = f.getOptions();
          fontSize = this.fontSizeOf(f);
        } else if (f instanceof PDFOptionList) {
          value = f.getSelected().join("\n");
          options = f.getOptions();
          fontSize = this.fontSizeOf(f);
        }
      } catch {
        /* malformed value: leave defaults */
      }

      const full = f.getName();
      return {
        name: full,
        partialName: decode(f.acroField.dict.get(PDFName.of("T"))) || full.split(".").pop() || full,
        type,
        tooltip: decode(f.acroField.dict.get(PDFName.of("TU"))),
        required: f.isRequired(),
        readOnly: f.isReadOnly(),
        value,
        options,
        multiline,
        maxLength,
        fontSize,
        widgets,
      };
    });
  }

  private fontSizeOf(f: PDFTextField | PDFDropdown | PDFOptionList): number | null {
    const da = f.acroField.getDefaultAppearance();
    const m = da && /([\d.]+)\s+Tf/.exec(da);
    return m ? Number(m[1]) : null;
  }

  // ---------- orphan widgets ----------

  /** Widget annotations on pages that belong to no field reachable from /AcroForm /Fields (stale duplicates). */
  private orphans(): { page: number; ref: PDFRef }[] {
    const known = new Set<string>();
    for (const f of this.doc.getForm().getFields()) {
      for (const w of f.acroField.getWidgets()) {
        const r = this.doc.context.getObjectRef(w.dict);
        if (r) known.add(r.toString());
      }
    }
    const out: { page: number; ref: PDFRef }[] = [];
    this.doc.getPages().forEach((p, i) => {
      p.node.Annots()?.asArray().forEach((a) => {
        if (!(a instanceof PDFRef)) return;
        const d = this.doc.context.lookup(a);
        if (!(d instanceof PDFDict) || d.get(PDFName.of("Subtype")) !== PDFName.of("Widget")) return;
        if (!known.has(a.toString())) out.push({ page: i, ref: a });
      });
    });
    return out;
  }

  orphanCount(): number {
    return this.orphans().length;
  }

  /** Removes stale widgets from the pages; returns how many were removed. */
  removeOrphans(): number {
    const found = this.orphans();
    for (const { page, ref } of found) {
      const annots = this.doc.getPage(page).node.Annots();
      const idx = annots?.indexOf(ref) ?? -1;
      if (idx >= 0) annots!.remove(idx);
    }
    return found.length;
  }

  // ---------- mutations ----------

  private field(name: string): PDFField {
    const f = this.doc.getForm().getFieldMaybe(name);
    if (!f) throw new Error(`Pole "${name}" neexistuje`);
    return f;
  }

  /** Returns the (possibly new) fully-qualified name. */
  update(name: string, patch: FieldPatch): string {
    const f = this.field(name);
    const dict: PDFDict = f.acroField.dict;

    if (patch.tooltip !== undefined) {
      if (patch.tooltip) dict.set(PDFName.of("TU"), PDFHexString.fromText(patch.tooltip));
      else dict.delete(PDFName.of("TU"));
    }
    if (patch.required !== undefined) patch.required ? f.enableRequired() : f.disableRequired();
    if (patch.readOnly !== undefined) patch.readOnly ? f.enableReadOnly() : f.disableReadOnly();

    if (f instanceof PDFTextField) {
      if (patch.multiline !== undefined) patch.multiline ? f.enableMultiline() : f.disableMultiline();
      if (patch.maxLength !== undefined) {
        if (patch.maxLength && patch.maxLength > 0) f.setMaxLength(patch.maxLength);
        else f.removeMaxLength();
      }
      if (patch.value !== undefined) f.setText(patch.value === "" ? undefined : patch.value);
    } else if (f instanceof PDFCheckBox) {
      if (patch.value !== undefined) patch.value === "true" ? f.check() : f.uncheck();
    } else if (f instanceof PDFRadioGroup) {
      if (patch.value !== undefined) {
        if (patch.value && f.getOptions().includes(patch.value)) f.select(patch.value);
        else f.clear();
      }
    } else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
      if (patch.options !== undefined) {
        f.clear();
        f.setOptions(patch.options);
      }
      if (patch.value !== undefined) {
        const vals = patch.value.split("\n").filter(Boolean);
        const known = new Set(f.getOptions());
        if (!vals.length) f.clear();
        else if (vals.every((v) => known.has(v))) f.select(f instanceof PDFDropdown ? vals[0] : vals);
      }
    }
    if (patch.fontSize !== undefined && (f instanceof PDFTextField || f instanceof PDFDropdown || f instanceof PDFOptionList)) {
      f.setFontSize(patch.fontSize);
    }

    if (patch.name !== undefined && patch.name && patch.name !== f.acroField.getPartialName()) {
      if (patch.name.includes(".")) throw new Error("Názov poľa nesmie obsahovať bodku");
      f.acroField.setPartialName(patch.name);
    }
    this.refreshAppearance(f);
    return f.getName();
  }

  moveWidget(name: string, widgetIndex: number, rect: Rect) {
    const f = this.field(name);
    const w = f.acroField.getWidgets()[widgetIndex];
    if (!w) throw new Error("Widget neexistuje");
    w.setRectangle(rect);
    this.refreshAppearance(f);
  }

  remove(name: string) {
    this.doc.getForm().removeField(this.field(name));
  }

  /**
   * Duplicates a field (all of its widgets) next to the original, named base_1, base_2, ...
   * Returns the new fully-qualified name.
   */
  clone(name: string): string {
    const form = this.doc.getForm();
    const ctx = this.doc.context;
    const f = this.field(name);
    const fd = f.acroField.dict;

    // new name: strip a trailing _N from the partial name, then take the first free base_N
    const full = f.getName();
    const partial = f.acroField.getPartialName() ?? full.split(".").pop() ?? full;
    const prefix = full.slice(0, full.length - partial.length);
    const base = partial.replace(/_\d+$/, "");
    let newPartial = "";
    for (let i = 1; ; i++) {
      newPartial = `${base}_${i}`;
      if (!form.getFieldMaybe(prefix + newPartial)) break;
    }

    const copy = (o: PDFObject): PDFObject => {
      if (o instanceof PDFDict) {
        const d = PDFDict.withContext(ctx);
        for (const [k, v] of o.entries()) d.set(k, copy(v));
        return d;
      }
      if (o instanceof PDFArray) {
        const a = ctx.obj([]) as PDFArray;
        for (let i = 0; i < o.size(); i++) a.push(copy(o.get(i)));
        return a;
      }
      return o; // refs (appearance streams, fonts), names, strings, numbers are shared/immutable
    };
    const SKIP = ["Kids", "StructParent", "NM", "Popup", "IRT"].map((k) => PDFName.of(k));
    const dup = (d: PDFDict): PDFDict => {
      const out = PDFDict.withContext(ctx);
      for (const [k, v] of d.entries()) if (!SKIP.includes(k)) out.set(k, copy(v));
      return out;
    };

    const widgets = f.acroField.getWidgets();
    const merged = widgets.length === 1 && widgets[0].dict === fd;

    // offset: right of the widgets' bounding box on the first widget's page; below it if there is no room
    const firstPage = widgets.length ? this.widgetPage(widgets[0]) : 0;
    const rects = widgets.filter((w) => this.widgetPage(w) === firstPage).map((w) => w.getRectangle());
    let dx = 0;
    let dy = 0;
    if (rects.length) {
      const x1 = Math.min(...rects.map((r) => r.x));
      const x2 = Math.max(...rects.map((r) => r.x + r.width));
      const y1 = Math.min(...rects.map((r) => r.y));
      const y2 = Math.max(...rects.map((r) => r.y + r.height));
      const pw = this.doc.getPage(firstPage).getWidth();
      if (x2 + 8 + (x2 - x1) <= pw) dx = x2 - x1 + 8;
      else if (y1 - 8 - (y2 - y1) >= 0) dy = -(y2 - y1 + 8);
      else dy = y2 - y1 + 8;
    }
    const shift = (w: PDFDict) => {
      const r = w.lookupMaybe(PDFName.of("Rect"), PDFArray);
      if (!r) return;
      const n = [0, 1, 2, 3].map((i) => r.lookup(i, PDFNumber).asNumber());
      w.set(PDFName.of("Rect"), ctx.obj([n[0] + dx, n[1] + dy, n[2] + dx, n[3] + dy]));
    };
    const addToPage = (ref: PDFRef, w: PDFWidgetAnnotation) => this.doc.getPage(this.widgetPage(w)).node.addAnnot(ref);
    const fieldDict = (d: PDFDict) => {
      d.set(PDFName.of("T"), PDFHexString.fromText(newPartial));
      // a copy of a digital signature must not carry the signature itself
      if (d.get(PDFName.of("FT")) === PDFName.of("Sig")) {
        d.delete(PDFName.of("V"));
        d.delete(PDFName.of("SV"));
        d.delete(PDFName.of("Lock"));
      }
    };

    let newRef: PDFRef;
    if (merged) {
      const nd = dup(fd);
      fieldDict(nd);
      shift(nd);
      newRef = ctx.register(nd);
      addToPage(newRef, widgets[0]);
    } else {
      const nf = dup(fd);
      fieldDict(nf);
      newRef = ctx.register(nf);
      const kids = ctx.obj([]) as PDFArray;
      for (const w of widgets) {
        const nw = dup(w.dict);
        nw.set(PDFName.of("Parent"), newRef);
        shift(nw);
        const r = ctx.register(nw);
        kids.push(r);
        addToPage(r, w);
      }
      nf.set(PDFName.of("Kids"), kids);
    }

    // hook into the hierarchy: under the original's parent, else at the top of the AcroForm
    const parent = fd.get(PDFName.of("Parent"));
    const parentDict = parent instanceof PDFRef ? ctx.lookup(parent, PDFDict) : undefined;
    const parentKids = parentDict?.lookupMaybe(PDFName.of("Kids"), PDFArray);
    if (parentKids) parentKids.push(newRef);
    else form.acroForm.addField(newRef);

    return prefix + newPartial;
  }

  // ---------- radio groups: every button is a widget with its own export value, position and size ----------

  /** Export value of one radio button (honours /Opt, where appearance states are just indices). */
  private radioOption(f: PDFRadioGroup, w: PDFWidgetAnnotation): string | undefined {
    const on = w.getOnValue()?.decodeText();
    if (on === undefined) return undefined;
    const ev = f.acroField.getExportValues();
    if (ev && /^\d+$/.test(on) && ev[Number(on)]) return ev[Number(on)].decodeText();
    return on;
  }

  private widgetPage(w: PDFWidgetAnnotation): number {
    const p = w.P();
    const pages = this.doc.getPages();
    if (p instanceof PDFRef) {
      const i = pages.findIndex((pg) => pg.ref === p || pg.ref.toString() === p.toString());
      if (i >= 0) return i;
    }
    const ref = this.doc.context.getObjectRef(w.dict);
    if (ref) {
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].node.Annots()?.indexOf(ref) !== undefined) return i;
      }
    }
    return 0;
  }

  /** Adds another button to a radio group, next to widget `afterWidget` with the same size. Returns its widget index. */
  addRadioOption(name: string, afterWidget: number, option?: string): number {
    const f = this.field(name);
    if (!(f instanceof PDFRadioGroup)) throw new Error("Pole nie je radio skupina");
    const ws = f.acroField.getWidgets();
    const ref = ws[Math.min(Math.max(afterWidget, 0), ws.length - 1)];
    const r = ref ? ref.getRectangle() : { x: 40, y: 40, width: 16, height: 16 };
    const pageIndex = ref ? this.widgetPage(ref) : 0;
    const page = this.doc.getPage(pageIndex);

    let x = r.x + r.width + 6;
    let y = r.y;
    if (x + r.width > page.getWidth()) {
      x = r.x;
      y = Math.max(0, r.y - r.height - 6);
    }
    const existing = new Set(f.getOptions());
    let opt = option || "";
    for (let i = existing.size + 1; !opt || existing.has(opt); i++) opt = `Option${i}`;

    f.addOptionToPage(opt, page, { x, y, width: r.width, height: r.height, borderWidth: 1, borderColor: rgb(0.25, 0.25, 0.25) });
    this.refreshAppearance(f);
    return f.acroField.getWidgets().length - 1;
  }

  /** Changes the export value of one radio button. */
  setWidgetOption(name: string, widgetIndex: number, option: string) {
    const f = this.field(name);
    if (!(f instanceof PDFRadioGroup)) throw new Error("Pole nie je radio skupina");
    const w = f.acroField.getWidgets()[widgetIndex];
    if (!w) throw new Error("Widget neexistuje");
    const old = w.getOnValue();
    if (!old) throw new Error("Tlačidlo nemá definovaný stav (chýba vzhľad)");
    const current = this.radioOption(f, w);
    if (!option) throw new Error("Hodnota tlačidla nesmie byť prázdna");
    if (option === "Off") throw new Error('Hodnota „Off“ je vyhradená pre nezvolený stav');
    if (option === current) return;
    if (f.getOptions().includes(option)) throw new Error(`Hodnota „${option}“ už v skupine existuje`);

    // /Opt present: appearance states are indices, the visible value lives in /Opt
    const opt = f.acroField.dict.lookupMaybe(PDFName.of("Opt"), PDFArray);
    const idx = Number(old.decodeText());
    if (opt && Number.isInteger(idx) && idx >= 0 && idx < opt.size()) {
      opt.set(idx, PDFHexString.fromText(option));
      return;
    }

    const next = PDFName.of(option);
    const ap = w.dict.lookupMaybe(PDFName.of("AP"), PDFDict);
    for (const key of ["N", "D"]) {
      const d = ap?.lookupMaybe(PDFName.of(key), PDFDict);
      if (d?.has(old)) {
        const v = d.get(old)!;
        d.delete(old);
        d.set(next, v);
      }
    }
    if (w.dict.get(PDFName.of("AS")) === old) w.dict.set(PDFName.of("AS"), next);
    // the group's value is shared by all of its buttons
    for (const holder of [f.acroField.dict, w.dict]) {
      if (holder.get(PDFName.of("V")) === old) holder.set(PDFName.of("V"), next);
    }
  }

  /** With /Opt the appearance states are indices; after a removal drop the dead entry and renumber the rest. */
  private compactRadioOpt(f: PDFRadioGroup) {
    const dict = f.acroField.dict;
    const opt = dict.lookupMaybe(PDFName.of("Opt"), PDFArray);
    if (!opt) return;
    const next = this.doc.context.obj([]) as PDFArray;
    const rename = new Map<string, PDFName>();
    for (const w of f.acroField.getWidgets()) {
      const old = w.getOnValue();
      const idx = old ? Number(old.decodeText()) : NaN;
      if (!old || !Number.isInteger(idx) || idx < 0 || idx >= opt.size()) continue;
      const to = PDFName.of(String(next.size()));
      next.push(opt.get(idx));
      rename.set(old.toString(), to);
      const ap = w.dict.lookupMaybe(PDFName.of("AP"), PDFDict);
      for (const key of ["N", "D"]) {
        const d = ap?.lookupMaybe(PDFName.of(key), PDFDict);
        if (d?.has(old)) {
          const v = d.get(old)!;
          d.delete(old);
          d.set(to, v);
        }
      }
      if (w.dict.get(PDFName.of("AS")) === old) w.dict.set(PDFName.of("AS"), to);
    }
    dict.set(PDFName.of("Opt"), next);
    const v = dict.get(PDFName.of("V"));
    if (v instanceof PDFName) {
      const to = rename.get(v.toString());
      if (to) dict.set(PDFName.of("V"), to);
    }
  }

  /** Removes one widget (e.g. one radio button) from its field and page. The last widget removes the whole field. */
  removeWidget(name: string, widgetIndex: number) {
    const f = this.field(name);
    const ws = f.acroField.getWidgets();
    const w = ws[widgetIndex];
    if (!w) throw new Error("Widget neexistuje");
    if (ws.length <= 1) return this.remove(name);

    const ref = this.doc.context.getObjectRef(w.dict);
    if (f instanceof PDFRadioGroup) {
      const on = this.radioOption(f, w);
      try {
        if (on !== undefined && f.getSelected() === on) f.clear();
      } catch {
        /* value malformed: leave it */
      }
    }
    f.acroField.removeWidget(widgetIndex);
    if (f instanceof PDFRadioGroup) this.compactRadioOpt(f);
    if (ref) {
      for (const p of this.doc.getPages()) {
        const annots = p.node.Annots();
        const i = annots?.indexOf(ref) ?? -1;
        if (i >= 0) annots!.remove(i);
      }
    }
  }

  /** Create a new field with one widget. Returns its name. */
  add(type: Exclude<FieldType, "unknown">, pageIndex: number, rect: Rect, wantedName?: string): string {
    const form = this.doc.getForm();
    const page = this.doc.getPage(pageIndex);
    const prefix = { text: "Text", checkbox: "Check", radio: "Radio", dropdown: "Combo", list: "List", button: "Button", signature: "Signature" }[type];
    let name = wantedName || "";
    for (let i = 1; !name || form.getFieldMaybe(name); i++) name = `${prefix}${i}`;

    if (type === "signature") {
      // pdf-lib has no createSignature(): build a merged field+widget dict by hand.
      const ctx = this.doc.context;
      const dict = ctx.obj({
        Type: "Annot",
        Subtype: "Widget",
        FT: "Sig",
        T: PDFHexString.fromText(name),
        Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
        F: 4,
        P: page.ref,
      });
      const ref = ctx.register(dict);
      page.node.addAnnot(ref);
      form.acroForm.addField(ref);
      return name;
    }

    const opts = { ...rect, borderWidth: 1, borderColor: rgb(0.25, 0.25, 0.25) };
    let field: PDFField;
    switch (type) {
      case "text": {
        const t = form.createTextField(name);
        t.addToPage(page, opts);
        field = t;
        break;
      }
      case "checkbox": {
        const c = form.createCheckBox(name);
        c.addToPage(page, opts);
        field = c;
        break;
      }
      case "radio": {
        const r = form.createRadioGroup(name);
        r.addOptionToPage("Option1", page, opts);
        field = r;
        break;
      }
      case "dropdown": {
        const d = form.createDropdown(name);
        d.addOptions(["Option 1", "Option 2"]);
        d.addToPage(page, opts);
        field = d;
        break;
      }
      case "list": {
        const l = form.createOptionList(name);
        l.addOptions(["Option 1", "Option 2", "Option 3"]);
        l.addToPage(page, opts);
        field = l;
        break;
      }
      case "button": {
        const b = form.createButton(name);
        b.addToPage("Button", page, opts);
        field = b;
        break;
      }
    }
    this.refreshAppearance(field);
    return name;
  }

  private font?: Awaited<ReturnType<PDFDocument["embedFont"]>>;
  private refreshAppearance(f: PDFField) {
    try {
      if (!this.font) throw new Error("font not ready");
      if (f instanceof PDFTextField || f instanceof PDFDropdown || f instanceof PDFOptionList || f instanceof PDFButton) {
        f.updateAppearances(this.font);
      } else if (f instanceof PDFCheckBox || f instanceof PDFRadioGroup) {
        f.updateAppearances();
      }
    } catch {
      /* appearance is best-effort; pdf.js renders widgets from field data anyway */
    }
  }
  /** Must be awaited once before the first mutation (embedding a font is async). */
  async prepare() {
    if (!this.font) this.font = await this.doc.embedFont(StandardFonts.Helvetica);
  }

  async save(): Promise<Uint8Array> {
    const bytes = await this.doc.save({ updateFieldAppearances: false });
    this.source = bytes;
    return bytes;
  }
}
