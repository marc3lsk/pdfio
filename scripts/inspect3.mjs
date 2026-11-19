import { PDFDocument, PDFName, PDFDict, PDFRef } from "pdf-lib";
import { readFileSync } from "node:fs";
const doc = await PDFDocument.load(readFileSync(process.argv[2]), { ignoreEncryption: true, updateMetadata: false });
const annots = doc.getPage(0).node.Annots().asArray();
for (const i of [0, 10, 6, 16]) {
  const d = doc.context.lookup(annots[i], PDFDict);
  const pr = d.get(PDFName.of("Parent"));
  const par = doc.context.lookup(pr, PDFDict);
  const kids = par.lookup(PDFName.of("Kids"))?.asArray().map(String);
  console.log(i, annots[i].toString(), "parent", pr.toString(), "kids", kids, "inAcroFormFields", doc.catalog.lookup(PDFName.of("AcroForm")).lookup(PDFName.of("Fields")).asArray().map(String).includes(pr.toString()));
}
console.log("trailer/producer:", doc.getProducer(), "|", doc.getCreator());
