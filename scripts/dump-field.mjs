import { PDFDocument, PDFName, PDFDict } from "pdf-lib";
import { readFileSync } from "node:fs";
const doc = await PDFDocument.load(readFileSync(process.argv[2]), { ignoreEncryption: true, updateMetadata: false });
for (const n of process.argv.slice(3)) {
  const f = doc.getForm().getField(n);
  console.log("==", n, "\nfield:", f.acroField.dict.toString().slice(0, 600));
  const w = f.acroField.getWidgets()[0];
  console.log("widget:", w.dict.toString().slice(0, 600));
}
