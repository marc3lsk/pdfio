//! Certificate chain validation for PDF signatures, delegated to the Windows CryptoAPI
//! (same trust store, intermediate fetching (AIA) and revocation checking as Windows itself uses).

use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct ChainRequest {
    /// DER certificates; `certs[0]` is the one to validate, the rest are extra intermediates (from the CMS).
    certs: Vec<Vec<u8>>,
    /// Validation time (ms since Unix epoch), typically the signing / timestamp time. None = now.
    time_ms: Option<f64>,
    /// Check CRL / OCSP (may go online; bounded by a timeout).
    revocation: bool,
}

#[derive(Serialize, Default)]
pub struct ChainResult {
    /// The chain ends in a root trusted by Windows and has no error flags.
    trusted: bool,
    /// CERT_TRUST_STATUS.dwErrorStatus of the whole chain (CERT_TRUST_* flags).
    error_status: u32,
    /// Display names, from the certificate itself up to the root.
    chain: Vec<String>,
}

#[cfg(windows)]
pub fn verify_chain(req: ChainRequest) -> Result<ChainResult, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Security::Cryptography::*;

    let enc = X509_ASN_ENCODING | PKCS_7_ASN_ENCODING;
    let first = req.certs.first().ok_or("no certificate")?;

    unsafe {
        let store = CertOpenStore(CERT_STORE_PROV_MEMORY, 0, 0, 0, null());
        if store.is_null() {
            return Err("CertOpenStore failed".into());
        }
        for der in req.certs.iter().skip(1) {
            // malformed extra certificates are ignored, they are only hints for chain building
            CertAddEncodedCertificateToStore(store, enc, der.as_ptr(), der.len() as u32, CERT_STORE_ADD_ALWAYS, null_mut());
        }
        let cert = CertCreateCertificateContext(enc, first.as_ptr(), first.len() as u32);
        if cert.is_null() {
            CertCloseStore(store, 0);
            return Err("invalid certificate".into());
        }

        let ft = req.time_ms.map(|ms| {
            // FILETIME: 100 ns ticks since 1601-01-01
            let ticks = ((ms / 1000.0 + 11_644_473_600.0) * 10_000_000.0) as u64;
            FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 }
        });
        let mut para: CERT_CHAIN_PARA = std::mem::zeroed();
        para.cbSize = std::mem::size_of::<CERT_CHAIN_PARA>() as u32;
        para.dwUrlRetrievalTimeout = 6000;
        let flags = if req.revocation {
            CERT_CHAIN_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT | CERT_CHAIN_REVOCATION_ACCUMULATIVE_TIMEOUT
        } else {
            0
        };

        let mut chain: *mut CERT_CHAIN_CONTEXT = null_mut();
        let ok = CertGetCertificateChain(
            null_mut(),
            cert,
            ft.as_ref().map_or(null(), |f| f as *const FILETIME),
            store,
            &para,
            flags,
            null(),
            &mut chain,
        );
        let mut out = ChainResult::default();
        if ok != 0 && !chain.is_null() {
            let c = &*chain;
            out.error_status = c.TrustStatus.dwErrorStatus;
            out.trusted = out.error_status & !(CERT_TRUST_REVOCATION_STATUS_UNKNOWN | CERT_TRUST_IS_OFFLINE_REVOCATION) == 0;
            if c.cChain > 0 {
                let simple = &**c.rgpChain;
                for i in 0..simple.cElement as usize {
                    let el = &**simple.rgpElement.add(i);
                    out.chain.push(display_name(el.pCertContext));
                }
            }
            CertFreeCertificateChain(chain);
        }
        CertFreeCertificateContext(cert);
        CertCloseStore(store, 0);
        if ok == 0 {
            return Err("CertGetCertificateChain failed".into());
        }
        Ok(out)
    }
}

#[cfg(windows)]
unsafe fn display_name(cert: *const windows_sys::Win32::Security::Cryptography::CERT_CONTEXT) -> String {
    use windows_sys::Win32::Security::Cryptography::*;
    let mut buf = [0u16; 512];
    let n = CertGetNameStringW(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, 0, std::ptr::null(), buf.as_mut_ptr(), buf.len() as u32);
    String::from_utf16_lossy(&buf[..(n as usize).saturating_sub(1)])
}

#[cfg(not(windows))]
pub fn verify_chain(_req: ChainRequest) -> Result<ChainResult, String> {
    Err("certificate validation is only implemented on Windows".into())
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn chains_from_dir() {
        let Ok(root) = std::env::var("SIGTRUST_DIR") else { return };
        let mut dirs: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().map(|e| e.path()).collect();
        dirs.sort();
        for d in dirs {
            let info = std::fs::read_to_string(d.join("info.txt")).unwrap_or_default();
            let mut certs = vec![];
            for i in 0.. {
                match std::fs::read(d.join(format!("{i}.der"))) { Ok(b) => certs.push(b), Err(_) => break }
            }
            let t = info.rsplit('|').next().and_then(|s| s.trim().parse::<f64>().ok());
            let t0 = std::time::Instant::now();
            let r = super::verify_chain(super::ChainRequest { certs, time_ms: t, revocation: true }).unwrap();
            println!("{info}\n   trusted={} status={:#x} {:?} ({:?})", r.trusted, r.error_status, r.chain, t0.elapsed());
        }
    }
}
