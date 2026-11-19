// Usage: node scripts/sig-to-text.mjs in.pdf out.pdf fieldName
// Converts a signature field into a text field (same name, same rectangle), styled like its text siblings.
import { PDFDocument, PDFName, PDFString, PDFSignature, StandardFonts } from "pdf-lib";
import { readFileSync, writeFileSync } from "node:fs";

const [inp, out, name] = process.argv.slice(2);
const opts = { ignoreEncryption: true, updateMetadata: false };

let doc = await PDFDocument.load(readFileSync(inp), opts);
const f = doc.getForm().getField(name);
if (!(f instanceof PDFSignature)) throw new Error(`${name} is not a signature field`);
const d = f.acroField.dict;
d.set(PDFName.of("FT"), PDFName.of("Tx"));
d.set(PDFName.of("DA"), PDFString.of("/Arial 11 Tf 0 0 0 rg"));
d.set(PDFName.of("V"), PDFString.of(""));
d.set(PDFName.of("DV"), PDFString.of(""));
const tmp = await doc.save({ updateFieldAppearances: false });

doc = await PDFDocument.load(tmp, opts);
const tf = doc.getForm().getTextField(name); // throws if conversion did not take
tf.updateAppearances(await doc.embedFont(StandardFonts.Helvetica));
writeFileSync(out, await doc.save({ updateFieldAppearances: false }));
console.log(`${name}: ${tf.constructor.name}, widgets=${tf.acroField.getWidgets().length}, rect=${JSON.stringify(tf.acroField.getWidgets()[0].getRectangle())}`);
