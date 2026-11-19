import { PDFDocument, PDFName, PDFDict, PDFRef, PDFArray } from "pdf-lib";
import { readFileSync } from "node:fs";
const doc = await PDFDocument.load(readFileSync(process.argv[2]), { ignoreEncryption: true, updateMetadata: false });
console.log("pages", doc.getPageCount(), "encrypted", doc.isEncrypted);
const af = doc.catalog.lookup(PDFName.of("AcroForm"));
console.log("AcroForm", !!af, af instanceof PDFDict && [...af.keys()].map(String).join(" "));
console.log("XFA", af instanceof PDFDict && af.has(PDFName.of("XFA")), "NeedAppearances", af instanceof PDFDict && String(af.get(PDFName.of("NeedAppearances"))));
const fields = doc.getForm().getFields();
console.log("fields", fields.length);
for (const f of fields.slice(0, 12)) {
  const ws = f.acroField.getWidgets();
  console.log(f.constructor.name, f.getName(), "widgets", ws.length, JSON.stringify(ws[0]?.getRectangle()), "AP", ws[0]?.dict.has(PDFName.of("AP")), "MK", ws[0]?.dict.has(PDFName.of("MK")));
}
doc.getPages().slice(0, 1).forEach((p, i) => {
  const annots = p.node.Annots()?.asArray() ?? [];
  const types = {};
  for (const a of annots) { const d = doc.context.lookup(a, PDFDict); const k = `${d.get(PDFName.of("Subtype"))}/${d.get(PDFName.of("FT")) ?? ""}`; types[k] = (types[k] || 0) + 1; }
  console.log("page", i + 1, "annots", annots.length, types, "size", p.getSize());
});
