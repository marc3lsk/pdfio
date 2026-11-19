// Usage: node scripts/unify-names.mjs in.pdf out.pdf
// Renames AcroFields to the naming used in KL_hr.pdf.
import { PDFDocument } from "pdf-lib";
import { readFileSync, writeFileSync } from "node:fs";

const MAP = {
  partnerAffectedPersonDepartment: "employee",
  Signature_1: "_SC1_",
  Signature_2: "_SC2_",
  Signature_3: "_SC3_",
  Signature_4: "_SC4_",
};
const [inp, out] = process.argv.slice(2);
const doc = await PDFDocument.load(readFileSync(inp), { ignoreEncryption: true, updateMetadata: false });
const form = doc.getForm();
for (const [from, to] of Object.entries(MAP)) {
  const f = form.getFieldMaybe(from);
  if (!f) continue;
  if (form.getFieldMaybe(to)) throw new Error(`target name ${to} already exists`);
  f.acroField.setPartialName(to);
  console.log(`  ${from} -> ${to}`);
}
writeFileSync(out, await doc.save({ updateFieldAppearances: false }));
console.log("written", out);
