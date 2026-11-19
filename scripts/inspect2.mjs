import { PDFDocument, PDFName, PDFDict, PDFRef } from "pdf-lib";
import { readFileSync } from "node:fs";
const doc = await PDFDocument.load(readFileSync(process.argv[2]), { ignoreEncryption: true, updateMetadata: false });
const p = doc.getPage(0);
const t = (d, k) => { const v = d.lookup(PDFName.of(k)); return v?.decodeText?.() ?? v?.toString?.(); };
p.node.Annots().asArray().forEach((a, i) => {
  const d = doc.context.lookup(a, PDFDict);
  const parent = d.lookup(PDFName.of("Parent"), PDFDict);
  console.log(i, a.toString(), "T=", t(d, "T"), "FT=", t(d, "FT") ?? (parent && "parent:" + t(parent, "FT")), "parent=", parent ? t(parent, "T") : "-", "Rect=", d.lookup(PDFName.of("Rect")).asArray().map(n => Math.round(n.asNumber())).join(","), "F=", t(d, "F"), "AP=", d.has(PDFName.of("AP")));
});
const af = doc.catalog.lookup(PDFName.of("AcroForm"));
console.log("Fields in AcroForm:", af.lookup(PDFName.of("Fields")).size());
