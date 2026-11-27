// Digital signatures: find them in the PDF, verify integrity (ByteRange digest + CMS signature) with pkijs,
// read the timestamp, and validate the signer's certificate chain against the Windows trust store (via Rust).
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFSignature, PDFString } from "pdf-lib";
import { FormEditor, type Rect } from "./forms";
import { verifyCertChain, type ChainResult } from "./platform";

pkijs.setEngine("webcrypto", new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto }));

export type SigStatus = "valid" | "warn" | "invalid" | "unknown" | "pending";

export interface CertInfo {
  name: string;
  org: string;
  email: string;
  issuer: string;
  serial: string;
  notBefore: Date;
  notAfter: Date;
}

export interface Check {
  ok: boolean | null; // null = could not be determined / informational
  text: string;
}

export interface SigInfo {
  index: number;
  fieldName: string | null;
  widget: { page: number; rect: Rect } | null;
  docTimestamp: boolean;
  subFilter: string;
  /** /Name, /Reason, /Location, /ContactInfo from the signature dictionary */
  name: string;
  reason: string;
  location: string;
  contact: string;
  /** when it was signed and where that time comes from */
  time: Date | null;
  timeSource: "timestamp" | "signed-attr" | "dict" | null;
  signer: CertInfo | null;
  tsa: string | null;
  digestAlg: string;
  /** 1-based: n-th signature in document order (by end of signed range) */
  revision: number;
  coversWholeFile: boolean;
  integrity: boolean | null;
  checks: Check[];
  chain: string[];
  status: SigStatus;
  summary: string;
  // internal, for the async trust step
  certs: Uint8Array[];
  trustTime: Date | null;
  laterChanges: "none" | "signatures" | "ltv" | "other";
  trust: "pending" | "ok" | "warn" | "invalid" | "unavailable";
}

const OID_HASH: Record<string, { name: string; web: string }> = {
  "1.3.14.3.2.26": { name: "SHA-1", web: "SHA-1" },
  "2.16.840.1.101.3.4.2.1": { name: "SHA-256", web: "SHA-256" },
  "2.16.840.1.101.3.4.2.2": { name: "SHA-384", web: "SHA-384" },
  "2.16.840.1.101.3.4.2.3": { name: "SHA-512", web: "SHA-512" },
};
const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";
const OID_TIMESTAMP_TOKEN = "1.2.840.113549.1.9.16.2.14";

const latin1 = new TextDecoder("latin1");

// ---------------------------------------------------------------- small helpers

function pdfText(o: unknown): string {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  if (o instanceof PDFName) return o.decodeText();
  return "";
}

/** "D:YYYYMMDDHHmmSSOHH'mm'" -> Date */
function parsePdfDate(s: string): Date | null {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s.trim());
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00", z, oh = "00", om = "00"] = m;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (z === "+" || z === "-") t -= (z === "+" ? 1 : -1) * (+oh * 60 + +om) * 60000;
  return Number.isNaN(t) ? null : new Date(t);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

const toBuf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function rdnValue(name: pkijs.RelativeDistinguishedNames, oid: string): string {
  const tv = name.typesAndValues.find((t) => t.type === oid);
  return tv ? String(tv.value.valueBlock.value ?? "") : "";
}

function certInfo(c: pkijs.Certificate): CertInfo {
  const cn = rdnValue(c.subject, "2.5.4.3");
  const given = rdnValue(c.subject, "2.5.4.42");
  const sur = rdnValue(c.subject, "2.5.4.4");
  return {
    name: cn || [given, sur].filter(Boolean).join(" ") || rdnValue(c.subject, "2.5.4.10") || "(bez mena)",
    org: rdnValue(c.subject, "2.5.4.10"),
    email: rdnValue(c.subject, "1.2.840.113549.1.9.1"),
    issuer: rdnValue(c.issuer, "2.5.4.3") || rdnValue(c.issuer, "2.5.4.10"),
    serial: [...c.serialNumber.valueBlock.valueHexView].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase(),
    notBefore: c.notBefore.value,
    notAfter: c.notAfter.value,
  };
}

const certDer = (c: pkijs.Certificate) => new Uint8Array(c.toSchema().toBER(false));

function parseSignedData(der: Uint8Array): pkijs.SignedData {
  const asn = asn1js.fromBER(toBuf(der));
  if (asn.offset === -1) throw new Error("CMS sa nedá dekódovať");
  const ci = new pkijs.ContentInfo({ schema: asn.result });
  if (ci.contentType !== pkijs.ContentInfo.SIGNED_DATA) throw new Error("CMS neobsahuje SignedData");
  return new pkijs.SignedData({ schema: ci.content });
}

function certsOf(sd: pkijs.SignedData): pkijs.Certificate[] {
  return (sd.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
}

/** The signer's certificate (issuer+serial or subject key identifier). */
function findSigner(sd: pkijs.SignedData): pkijs.Certificate | null {
  const sid = sd.signerInfos[0]?.sid;
  const certs = certsOf(sd);
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    return certs.find((c) => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber)) ?? null;
  }
  if (sid instanceof asn1js.OctetString) {
    const want = new Uint8Array(sid.valueBlock.valueHexView);
    return (
      certs.find((c) => {
        const ext = c.extensions?.find((e) => e.extnID === "2.5.29.14");
        const v = ext?.parsedValue;
        return v instanceof asn1js.OctetString && eq(new Uint8Array(v.valueBlock.valueHexView), want);
      }) ?? null
    );
  }
  return null;
}

/** For timestamp tokens `data` is the timestamped data (pkijs then also checks the messageImprint). */
async function verifySd(sd: pkijs.SignedData, data?: ArrayBuffer): Promise<{ ok: boolean; message: string; signer: pkijs.Certificate | null }> {
  try {
    const r = await sd.verify({ signer: 0, data, checkChain: false, extendedMode: true });
    return { ok: !!r.signatureVerified, message: r.message, signer: r.signerCertificate ?? findSigner(sd) };
  } catch (e) {
    const err = e as pkijs.SignedDataVerifyError;
    return { ok: false, message: err?.message ?? String(e), signer: err?.signerCertificate ?? findSigner(sd) };
  }
}

function tstInfoOf(sd: pkijs.SignedData): pkijs.TSTInfo {
  const ec = sd.encapContentInfo.eContent;
  if (!ec) throw new Error("časová pečiatka neobsahuje TSTInfo");
  return new pkijs.TSTInfo({ schema: asn1js.fromBER(ec.getValue()).result });
}

async function imprintMatches(tst: pkijs.TSTInfo, data: ArrayBuffer): Promise<boolean> {
  const alg = OID_HASH[tst.messageImprint.hashAlgorithm.algorithmId];
  if (!alg) return false;
  const h = new Uint8Array(await crypto.subtle.digest(alg.web, data));
  return eq(h, new Uint8Array(tst.messageImprint.hashedMessage.valueBlock.valueHexView));
}

// ---------------------------------------------------------------- PDF side

interface RawSig {
  range: [number, number, number, number];
  contents: Uint8Array | null;
  dict: PDFDict | null;
  fieldName: string | null;
  widget: { page: number; rect: Rect } | null;
}

/** Quick pre-check, so unsigned documents never pay for a pdf-lib parse. */
export function mayHaveSignatures(bytes: Uint8Array): boolean {
  const needle = [0x2f, 0x42, 0x79, 0x74, 0x65, 0x52, 0x61, 0x6e, 0x67, 0x65]; // "/ByteRange"
  outer: for (let i = bytes.indexOf(0x2f); i >= 0 && i < bytes.length - needle.length; i = bytes.indexOf(0x2f, i + 1)) {
    for (let k = 1; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

async function collect(bytes: Uint8Array): Promise<RawSig[]> {
  const ed = await FormEditor.load(bytes);
  const fields = ed.list();
  const doc = ed.doc;
  const byRange = new Map<string, RawSig>();

  const rangeOf = (d: PDFDict): [number, number, number, number] | null => {
    const br = d.lookup(PDFName.of("ByteRange"));
    if (!(br instanceof PDFArray) || br.size() !== 4) return null;
    const n = br.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN));
    return n.some((x) => !Number.isFinite(x)) ? null : (n as [number, number, number, number]);
  };
  const add = (d: PDFDict, fieldName: string | null, widget: RawSig["widget"]) => {
    const range = rangeOf(d);
    if (!range) return;
    const key = range.join(",");
    const prev = byRange.get(key);
    if (prev) {
      prev.fieldName ??= fieldName;
      prev.widget ??= widget;
      return;
    }
    // /Contents is read straight from the file: it is exactly the gap between the two signed ranges
    let contents: Uint8Array | null = null;
    const [a, b, c] = range;
    if (a === 0 && c > a + b && c <= bytes.length && bytes[a + b] === 0x3c && bytes[c - 1] === 0x3e) {
      contents = hexToBytes(latin1.decode(bytes.subarray(a + b + 1, c - 1)));
    }
    byRange.set(key, { range, contents, dict: d, fieldName, widget });
  };

  for (const f of doc.getForm().getFields()) {
    if (!(f instanceof PDFSignature)) continue;
    const v = f.acroField.dict.lookup(PDFName.of("V"));
    if (!(v instanceof PDFDict)) continue;
    const info = fields.find((x) => x.name === f.getName());
    const w = info?.widgets.find((x) => x.page >= 0 && x.rect.width > 1 && x.rect.height > 1) ?? info?.widgets.find((x) => x.page >= 0);
    add(v, f.getName(), w ? { page: w.page, rect: w.rect } : null);
  }
  // signatures not reachable from the form (broken AcroForm, orphaned fields)
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.has(PDFName.of("ByteRange")) && obj.has(PDFName.of("Contents"))) add(obj, null, null);
  }
  return [...byRange.values()].sort((x, y) => x.range[2] + x.range[3] - (y.range[2] + y.range[3]));
}

/** End offsets of all revisions (just after each %%EOF + EOL). */
function revisionEnds(bytes: Uint8Array): number[] {
  const s = latin1.decode(bytes);
  const out: number[] = [];
  for (let i = s.indexOf("%%EOF"); i >= 0; i = s.indexOf("%%EOF", i + 5)) {
    let e = i + 5;
    while (e < s.length && (s[e] === "\r" || s[e] === "\n")) e++;
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------- verification

async function verifyOne(bytes: Uint8Array, raw: RawSig, all: RawSig[], revEnds: number[], index: number): Promise<SigInfo> {
  const d = raw.dict;
  const get = (k: string) => pdfText(d?.lookup(PDFName.of(k)));
  const subFilter = get("SubFilter");
  const s: SigInfo = {
    index,
    fieldName: raw.fieldName,
    widget: raw.widget,
    docTimestamp: get("Type") === "DocTimeStamp" || subFilter === "ETSI.RFC3161",
    subFilter,
    name: get("Name"),
    reason: get("Reason"),
    location: get("Location"),
    contact: get("ContactInfo"),
    time: null,
    timeSource: null,
    signer: null,
    tsa: null,
    digestAlg: "",
    revision: index + 1,
    coversWholeFile: false,
    integrity: null,
    checks: [],
    chain: [],
    status: "pending",
    summary: "",
    certs: [],
    trustTime: null,
    laterChanges: "none",
    trust: "pending",
  };
  const dictTime = parsePdfDate(get("M"));
  if (dictTime) [s.time, s.timeSource] = [dictTime, "dict"];

  const [a, b, c, len2] = raw.range;
  const end = c + len2;
  if (!raw.contents || end > bytes.length) {
    s.integrity = false;
    s.checks.push({ ok: false, text: "Rozsah podpísaných dát (ByteRange) je poškodený – podpis nezodpovedá súboru" });
    return finish(s);
  }

  // what happened after this signature was applied
  const tailEnd = (() => {
    let e = end;
    while (e < bytes.length && (bytes[e] === 0x0d || bytes[e] === 0x0a || bytes[e] === 0x20)) e++;
    return e;
  })();
  s.coversWholeFile = tailEnd >= bytes.length;
  if (!s.coversWholeFile) {
    const later = revEnds.filter((e) => e > tailEnd);
    const sigEnds = new Set(all.map((r) => r.range[2] + r.range[3]));
    let kind: SigInfo["laterChanges"] = "signatures";
    let from = tailEnd;
    for (const e of later.length ? later : [bytes.length]) {
      const isSig = [...sigEnds].some((x) => x > from && x <= e && e - x <= 4);
      if (!isSig) {
        const chunk = latin1.decode(bytes.subarray(from, e));
        if (/\/FT\s*\/Sig\b/.test(chunk)) {
          // preparing the next signature (new signature field + widget), usually with an info/XMP update
        } else if (/\/DSS\b|\/VRI\b/.test(chunk) && !/\/Subtype\s*\/(?!Widget|XML)\w+/.test(chunk)) {
          if (kind === "signatures") kind = "ltv";
        } else kind = "other";
      }
      from = e;
    }
    s.laterChanges = kind;
  }

  const signedData = new Uint8Array(b + len2);
  signedData.set(bytes.subarray(a, a + b), 0);
  signedData.set(bytes.subarray(c, end), b);

  try {
    if (subFilter === "adbe.x509.rsa_sha1") {
      s.checks.push({ ok: null, text: "Formát podpisu adbe.x509.rsa_sha1 zatiaľ nie je podporovaný" });
      return finish(s);
    }
    const sd = parseSignedData(raw.contents);
    const si = sd.signerInfos[0];
    if (!si) throw new Error("CMS neobsahuje údaje o podpisovateľovi");
    s.digestAlg = OID_HASH[si.digestAlgorithm.algorithmId]?.name ?? si.digestAlgorithm.algorithmId;

    let ok: boolean;
    let signer: pkijs.Certificate | null;
    if (s.docTimestamp) {
      // RFC 3161 document timestamp: the token's messageImprint is the hash of the signed ranges
      const v = await verifySd(sd, toBuf(signedData));
      const tst = tstInfoOf(sd);
      ok = v.ok && (await imprintMatches(tst, toBuf(signedData)));
      signer = v.signer;
      [s.time, s.timeSource] = [tst.genTime, "timestamp"];
      s.trustTime = tst.genTime;
    } else if (subFilter === "adbe.pkcs7.sha1") {
      // the signed content is the SHA-1 of the ranges, encapsulated
      const v = await verifySd(sd);
      const inner = sd.encapContentInfo.eContent?.getValue();
      const h = new Uint8Array(await crypto.subtle.digest("SHA-1", toBuf(signedData)));
      ok = v.ok && !!inner && eq(new Uint8Array(inner), h);
      signer = v.signer;
    } else {
      const v = await verifySd(sd, toBuf(signedData));
      ok = v.ok;
      signer = v.signer;
    }
    s.integrity = ok;
    s.checks.push(
      ok
        ? { ok: true, text: s.coversWholeFile ? "Dokument nebol od podpísania zmenený" : "Podpísaná verzia dokumentu nebola zmenená" }
        : { ok: false, text: "Dokument bol po podpísaní zmenený alebo je podpis poškodený" },
    );

    if (signer) {
      s.signer = certInfo(signer);
      s.certs = [certDer(signer), ...certsOf(sd).filter((x) => x !== signer).map(certDer)];
    } else s.checks.push({ ok: false, text: "Certifikát podpisovateľa nie je súčasťou podpisu" });

    if (!s.docTimestamp) {
      const st = si.signedAttrs?.attributes.find((x) => x.type === OID_SIGNING_TIME);
      const stv = st?.values[0];
      if (stv instanceof asn1js.UTCTime || stv instanceof asn1js.GeneralizedTime) [s.time, s.timeSource] = [stv.toDate(), "signed-attr"];

      // signature timestamp (unsigned attribute): proves the signature existed at genTime
      const tsAttr = si.unsignedAttrs?.attributes.find((x) => x.type === OID_TIMESTAMP_TOKEN);
      if (tsAttr) {
        try {
          const tsd = new pkijs.SignedData({ schema: new pkijs.ContentInfo({ schema: tsAttr.values[0] }).content });
          const sigValue = toBuf(new Uint8Array(si.signature.valueBlock.valueHexView));
          const tv = await verifySd(tsd, sigValue);
          const tst = tstInfoOf(tsd);
          const tsOk = tv.ok && (await imprintMatches(tst, sigValue));
          s.tsa = tv.signer ? certInfo(tv.signer).name : null;
          if (tsOk) {
            [s.time, s.timeSource] = [tst.genTime, "timestamp"];
            s.trustTime = tst.genTime;
          }
          s.checks.push({ ok: tsOk, text: tsOk ? `Časová pečiatka je platná${s.tsa ? ` (${s.tsa})` : ""}` : "Časová pečiatka je neplatná" });
        } catch (e) {
          s.checks.push({ ok: false, text: `Časovú pečiatku sa nepodarilo prečítať: ${e instanceof Error ? e.message : e}` });
        }
      }
    }
    s.trustTime ??= s.time;
  } catch (e) {
    s.integrity = null;
    s.checks.push({ ok: null, text: `Podpis sa nepodarilo overiť: ${e instanceof Error ? e.message : e}` });
  }

  if (!s.coversWholeFile && s.integrity) {
    s.checks.push(
      s.laterChanges === "signatures"
        ? { ok: true, text: "Po podpísaní boli pridané už len ďalšie podpisy" }
        : s.laterChanges === "ltv"
          ? { ok: true, text: "Po podpísaní boli doplnené údaje na dlhodobé overenie (LTV)" }
          : { ok: null, text: "Po podpísaní bol dokument ďalej upravovaný (napr. vyplnenie polí, anotácie) – podpis sa vzťahuje na skoršiu verziu" },
    );
  }
  return s;
}

// ---------------------------------------------------------------- certificate trust

const TRUST_FLAGS: [number, string, "invalid" | "warn" | "info"][] = [
  [0x4, "Certifikát podpisovateľa bol zrušený (revokovaný)", "invalid"],
  [0x8, "Podpis niektorého certifikátu v reťazci je neplatný", "invalid"],
  [0x4000000, "Certifikát je vo Windows výslovne označený ako nedôveryhodný", "invalid"],
  [0x1, "Certifikát nebol v čase podpisu platný (expirovaný alebo ešte neplatný)", "warn"],
  [0x20, "Koreňový certifikát vydavateľa nie je dôveryhodný (chýba v úložisku Windows)", "warn"],
  [0x10000, "Reťazec certifikátov je neúplný – vydavateľa sa nepodarilo nájsť", "warn"],
  [0x10, "Certifikát nie je určený na tento účel", "warn"],
  [0x80, "Reťazec certifikátov je cyklický", "warn"],
  [0x100 | 0x200 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x4000 | 0x8000, "Certifikát obsahuje neplatné rozšírenia alebo obmedzenia", "warn"],
  [0x40 | 0x1000000, "Stav zrušenia certifikátu sa nepodarilo overiť (CRL/OCSP nedostupné)", "info"],
];

const trustCache = new Map<string, Promise<ChainResult | null>>();

async function trustOf(s: SigInfo): Promise<ChainResult | null> {
  const t = s.trustTime?.getTime() ?? null;
  const fp = new Uint8Array(await crypto.subtle.digest("SHA-256", toBuf(s.certs[0])));
  const key = `${[...fp].join(".")}@${t}`;
  let p = trustCache.get(key);
  if (!p) {
    p = verifyCertChain(s.certs, t, true).catch(() => null);
    trustCache.set(key, p);
  }
  return p;
}

/** Derive status + one-line summary from integrity, checks and trust. */
function finish(s: SigInfo): SigInfo {
  const what = s.docTimestamp ? "Časová pečiatka" : "Podpis";
  if (s.integrity === false) {
    s.status = "invalid";
    s.summary = `${what} je NEPLATN${s.docTimestamp ? "Á" : "Ý"} – dokument bol po podpísaní zmenený`;
  } else if (s.integrity === null) {
    s.status = "unknown";
    s.summary = `Platnosť sa nepodarilo overiť`;
  } else if (s.trust === "invalid") {
    s.status = "invalid";
    s.summary = `${what} je NEPLATN${s.docTimestamp ? "Á" : "Ý"} – problém s certifikátom`;
  } else if (s.trust === "pending") {
    s.status = "pending";
    s.summary = "Dokument je neporušený, overujem certifikát…";
  } else if (s.trust === "unavailable") {
    s.status = "warn";
    s.summary = "Dokument je neporušený, dôveryhodnosť podpisovateľa nebola overená";
  } else if (s.trust === "warn") {
    s.status = "warn";
    s.summary = "Dokument je neporušený, ale identitu podpisovateľa sa nepodarilo overiť";
  } else if (s.checks.some((c) => c.ok === false) || s.laterChanges === "other") {
    s.status = "warn";
    s.summary = s.laterChanges === "other" ? `${what} je platn${s.docTimestamp ? "á" : "ý"}, dokument bol potom upravený` : `${what} je platn${s.docTimestamp ? "á" : "ý"}, s výhradami`;
  } else {
    s.status = "valid";
    s.summary = `${what} je platn${s.docTimestamp ? "á" : "ý"}`;
  }
  return s;
}

/** Apply the certificate-chain result to a signature (mutates). */
async function applyTrust(s: SigInfo): Promise<void> {
  if (!s.integrity || !s.certs.length) {
    s.trust = "unavailable";
    return void finish(s);
  }
  const r = await trustOf(s);
  if (!r) {
    s.checks.push({ ok: null, text: "Dôveryhodnosť certifikátu sa dá overiť len v desktopovej aplikácii" });
    s.trust = "unavailable";
    return void finish(s);
  }
  s.chain = r.chain;
  let level: SigInfo["trust"] = "ok";
  const msgs: Check[] = [];
  for (const [flag, text, sev] of TRUST_FLAGS) {
    if (!(r.error_status & flag)) continue;
    msgs.push({ ok: sev === "info" ? null : false, text });
    if (sev === "invalid") level = "invalid";
    else if (sev === "warn" && level === "ok") level = "warn";
  }
  if (r.trusted) msgs.unshift({ ok: true, text: `Certifikát podpisovateľa je dôveryhodný${s.trustTime ? ` (k ${fmtDate(s.trustTime)})` : ""}` });
  s.checks.push(...msgs);
  s.trust = level;
  finish(s);
}

export const fmtDate = (d: Date) => d.toLocaleString("sk-SK", { dateStyle: "medium", timeStyle: "medium" });

/**
 * Find and verify all signatures. `onUpdate` fires once the cryptographic checks are done (trust still pending)
 * and again when certificate validation has finished.
 */
export async function analyzeSignatures(bytes: Uint8Array, onUpdate: (sigs: SigInfo[]) => void): Promise<SigInfo[]> {
  if (!mayHaveSignatures(bytes)) {
    onUpdate([]);
    return [];
  }
  const raws = await collect(bytes);
  const revEnds = revisionEnds(bytes);
  const sigs = await Promise.all(raws.map((r, i) => verifyOne(bytes, r, raws, revEnds, i).then(finish)));
  onUpdate(sigs);
  await Promise.all(sigs.map(applyTrust));
  onUpdate(sigs);
  return sigs;
}

/** Worst status first: invalid > unknown > warn > pending > valid. */
export function overallStatus(sigs: SigInfo[]): SigStatus {
  const order: SigStatus[] = ["invalid", "unknown", "warn", "pending", "valid"];
  for (const st of order) if (sigs.some((s) => s.status === st)) return st;
  return "valid";
}
