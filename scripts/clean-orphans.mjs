// Usage: node scripts/clean-orphans.mjs in.pdf out.pdf
// Removes widget annotations that belong to no field reachable from /AcroForm /Fields (and their dead parents).
import { PDFDocument, PDFName, PDFDict, PDFRef } from "pdf-lib";
import { readFileSync, writeFileSync } from "node:fs";

const [inp, out] = process.argv.slice(2);
const doc = await PDFDocument.load(readFileSync(inp), { ignoreEncryption: true, updateMetadata: false });
const known = new Set();
for (const f of doc.getForm().getFields())
  for (const w of f.acroField.getWidgets()) known.add(doc.context.getObjectRef(w.dict)?.toString());

let removed = 0;
for (const page of doc.getPages()) {
  const annots = page.node.Annots();
  if (!annots) continue;
  for (let i = annots.size() - 1; i >= 0; i--) {
    const ref = annots.get(i);
    const d = ref instanceof PDFRef ? doc.context.lookup(ref) : undefined;
    if (!(d instanceof PDFDict) || d.get(PDFName.of("Subtype")) !== PDFName.of("Widget") || known.has(ref.toString())) continue;
    const parent = d.get(PDFName.of("Parent"));
    annots.remove(i);
    doc.context.delete(ref);
    if (parent instanceof PDFRef) doc.context.delete(parent); // dead field dict (not in /Fields)
    removed++;
  }
}
writeFileSync(out, await doc.save({ updateFieldAppearances: false }));
console.log(`removed ${removed} orphan widgets -> ${out}`);
