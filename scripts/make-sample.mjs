// Generates sample.pdf with a few AcroForm fields for manual testing: node scripts/make-sample.mjs
import { PDFDocument, PDFHexString, PDFName, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let p = 1; p <= 3; p++) {
  const page = doc.addPage([595, 842]);
  page.drawText(`PDFio sample – page ${p}`, { x: 50, y: 790, size: 22, font, color: rgb(0.1, 0.1, 0.1) });
  page.drawText("The quick brown fox jumps over the lazy dog. Searchable and selectable text.", { x: 50, y: 760, size: 11, font });
  if (p === 1) {
    const form = doc.getForm();
    page.drawText("Name:", { x: 50, y: 700, size: 12, font });
    const name = form.createTextField("customer.name");
    name.setText("Jane Doe");
    name.addToPage(page, { x: 110, y: 692, width: 220, height: 22 });
    page.drawText("Subscribe:", { x: 50, y: 660, size: 12, font });
    const cb = form.createCheckBox("subscribe");
    cb.addToPage(page, { x: 130, y: 656, width: 16, height: 16 });
    page.drawText("Country:", { x: 50, y: 620, size: 12, font });
    const dd = form.createDropdown("country");
    dd.addOptions(["Slovakia", "Czechia", "Austria"]);
    dd.select("Slovakia");
    dd.addToPage(page, { x: 110, y: 612, width: 160, height: 22 });
    page.drawText("Plan:", { x: 50, y: 580, size: 12, font });
    const rg = form.createRadioGroup("plan");
    rg.addOptionToPage("free", page, { x: 110, y: 576, width: 16, height: 16 });
    rg.addOptionToPage("pro", page, { x: 150, y: 576, width: 16, height: 16 });
    rg.select("free");
    const notes = form.createTextField("notes");
    notes.enableMultiline();
    notes.addToPage(page, { x: 50, y: 470, width: 300, height: 80 });
    notes.setText("Multi-line\nnotes");
    name.enableRequired();
    name.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText("Full name of the customer"));
  }
}
writeFileSync("sample.pdf", await doc.save());
console.log("sample.pdf written");
