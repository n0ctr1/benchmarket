//! Inference attestation: proof that an answer is the exact output of a NEAR AI Cloud completion.
//!
//! NEAR AI signs `<request_sha256>:<response_sha256>` (gateway) or
//! `<model>:<request_sha256>:<response_sha256>` (provider TEE) with an ed25519 key whose
//! attestation report anyone can fetch. The owner lists the trusted signing keys after checking
//! those reports. An attested answer commits `answer_hash = "sha256:" + response_sha256`, so the
//! verifier must score the very response the key signed. The request hash binds the model, the
//! agent's system prompt and the round's prompt (which names the round), which the verifier
//! checks off chain against the agent's `config_hash`.
//!
//! Two kinds of keys sign: a model's own enclave (`model:` in the trusted list; NEAR AI hosts the
//! model in a TEE and the signed text names the model), and the NEAR AI gateway (`gateway:`, or a
//! bare key; the model runs at an outside provider). Signatures are ed25519 (key as 64 hex) or
//! ECDSA secp256k1 over the EIP-191 message (key as a 0x address). The model is recorded only when
//! a model key signed, so `model.is_some()` means "this response came out of that model's enclave".

use near_sdk::{env, near};

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attestation {
    /// The signed text, exactly as NEAR AI returns it.
    pub text: String,
    /// 64-byte ed25519 signature, hex.
    pub signature: String,
    /// 32-byte ed25519 public key, hex (NEAR AI calls it `signing_address`).
    pub signer: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attested {
    /// Set only when the model's own enclave signed.
    pub model: Option<String>,
    pub request_hash: String,
    pub response_hash: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignerKind {
    Model,
    Gateway,
}

/// Splits a trusted-list entry into its kind and key (lowercase). A bare key is a gateway key.
pub fn parse_signer(entry: &str) -> Option<(SignerKind, String)> {
    let (kind, key) = match entry.split_once(':') {
        Some(("model", k)) => (SignerKind::Model, k),
        Some(("gateway", k)) => (SignerKind::Gateway, k),
        None => (SignerKind::Gateway, entry),
        _ => return None,
    };
    let key = key.to_ascii_lowercase();
    let ok = (key.len() == 64 && hex_decode(&key).is_some())
        || (key.len() == 42 && key.starts_with("0x") && hex_decode(&key[2..]).is_some());
    ok.then_some((kind, key))
}

/// Address that signed `text` as an EIP-191 personal message, lowercase 0x-hex.
fn ecdsa_signer(text: &str, signature: &str) -> Option<String> {
    let raw = hex_decode(signature.strip_prefix("0x").unwrap_or(signature))?;
    if raw.len() != 65 {
        return None;
    }
    let v = match raw[64] {
        27 | 28 => raw[64] - 27,
        0 | 1 => raw[64],
        _ => return None,
    };
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let hash = env::keccak256_array(&msg);
    let pk = env::ecrecover(&hash, &raw[..64], v, false)?;
    let addr = env::keccak256_array(&pk);
    Some(format!("0x{}", addr[12..].iter().map(|b| format!("{b:02x}")).collect::<String>()))
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

pub fn parse_text(text: &str) -> Option<Attested> {
    let mut parts = text.rsplitn(3, ':');
    let response_hash = parts.next()?;
    let request_hash = parts.next()?;
    let model = parts.next().filter(|m| !m.is_empty()).map(str::to_string);
    if !is_hash(response_hash) || !is_hash(request_hash) {
        return None;
    }
    Some(Attested { model, request_hash: request_hash.into(), response_hash: response_hash.into() })
}

/// Checks the signature and the signer, and returns what the text commits to.
pub fn verify(a: &Attestation, trusted: &[String]) -> Result<Attested, String> {
    if a.text.len() > 256 {
        return Err("attestation text too long".into());
    }
    let signer = a.signer.to_ascii_lowercase();
    let kind = trusted
        .iter()
        .filter_map(|t| parse_signer(t))
        .find(|(_, k)| *k == signer)
        .map(|(kind, _)| kind)
        .ok_or("attestation signer is not trusted")?;
    if signer.starts_with("0x") {
        if ecdsa_signer(&a.text, &a.signature).as_deref() != Some(signer.as_str()) {
            return Err("attestation signature does not verify".into());
        }
    } else {
        let sig: [u8; 64] = hex_decode(&a.signature).and_then(|v| v.try_into().ok()).ok_or("bad attestation signature")?;
        let pk: [u8; 32] = hex_decode(&signer).and_then(|v| v.try_into().ok()).ok_or("bad attestation signer")?;
        if !env::ed25519_verify(&sig, a.text.as_bytes(), &pk) {
            return Err("attestation signature does not verify".into());
        }
    }
    let mut out = parse_text(&a.text).ok_or("attestation text is not <request>:<response>")?;
    if kind != SignerKind::Model {
        out.model = None;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    // A real NEAR AI Cloud gateway signature (round 10, echo).
    const TEXT: &str = "ed12232d4055873a813ccdb6da40c818b64cd5367b223f8ced7cc1a437034d85:c3ab0df85ed4b729076352f92d719772f3b7621a31aa6b549aafe6189638cf1d";
    const SIG: &str = "f72bb8505169c56230c3eaff6e1a8f0b1516a69cb9d27b596ec037113428310138cf6f1366058e52eda4211734c090e9711617aeaba58987e0286df9729e0401";
    const SIGNER: &str = "40599fb284f43953bb356b09080fd803c960fc10285ad90eca462ca711ad4acb";

    fn att(text: &str) -> Attestation {
        Attestation { text: text.into(), signature: SIG.into(), signer: SIGNER.into() }
    }

    #[test]
    fn verifies_a_real_near_ai_signature() {
        testing_env!(VMContextBuilder::new().build());
        let a = verify(&att(TEXT), &[SIGNER.into()]).unwrap();
        assert_eq!(a.model, None);
        assert_eq!(a.response_hash, "c3ab0df85ed4b729076352f92d719772f3b7621a31aa6b549aafe6189638cf1d");
    }

    #[test]
    fn rejects_untrusted_or_altered() {
        testing_env!(VMContextBuilder::new().build());
        assert!(verify(&att(TEXT), &[]).unwrap_err().contains("not trusted"));
        let altered = TEXT.replacen('e', "f", 1);
        assert!(verify(&att(&altered), &[SIGNER.into()]).unwrap_err().contains("does not verify"));
    }

    // A real model-enclave ECDSA signature from NEAR AI Cloud (GLM 5.3, provider_tee).
    const TEE_TEXT: &str = "z-ai/glm-5.3-flash:7d948ea65843e5895371355867545313ff2b8ceb12c16674eba1a9f96f568d03:3539d3009b9e81f56db30373f34cd5b4886399d7c752ad9808f715fe9bc39d26";
    const TEE_SIG: &str = "0x44cdcfe83cacc9c01d9221852d81d68fe8ea49262c82a5536eab3dc5b445f0d50aab1b4c0952ec2e4b3f4a8fa99588da4d1d78dba683ad6b90788f06fce918361c";
    const TEE_SIGNER: &str = "0x3b753b4406613c5e70ae640508632b600424fa0c";

    #[test]
    fn verifies_a_real_model_enclave_signature() {
        testing_env!(VMContextBuilder::new().build());
        let a = Attestation { text: TEE_TEXT.into(), signature: TEE_SIG.into(), signer: TEE_SIGNER.into() };
        let got = verify(&a, &[format!("model:{TEE_SIGNER}")]).unwrap();
        assert_eq!(got.model.as_deref(), Some("z-ai/glm-5.3-flash"));
        // Listed as a gateway key, the same signature does not claim the model's enclave.
        assert_eq!(verify(&a, &[format!("gateway:{TEE_SIGNER}")]).unwrap().model, None);
        let forged = Attestation { text: TEE_TEXT.replacen('7', "8", 1), ..a };
        assert!(verify(&forged, &[format!("model:{TEE_SIGNER}")]).unwrap_err().contains("does not verify"));
    }

    #[test]
    fn signer_entries() {
        assert_eq!(parse_signer(SIGNER), Some((SignerKind::Gateway, SIGNER.into())));
        assert_eq!(parse_signer(&format!("model:{}", TEE_SIGNER.to_uppercase().replace("0X", "0x"))).unwrap().0, SignerKind::Model);
        assert!(parse_signer("model:0x12").is_none());
        assert!(parse_signer("other:0x3b753b4406613c5e70ae640508632b600424fa0c").is_none());
    }

    #[test]
    fn parses_provider_form_with_model() {
        let t = format!("z-ai/glm-5.3-flash:{}:{}", "a".repeat(64), "b".repeat(64));
        let a = parse_text(&t).unwrap();
        assert_eq!(a.model.as_deref(), Some("z-ai/glm-5.3-flash"));
        assert_eq!(a.request_hash, "a".repeat(64));
        assert!(parse_text("nope").is_none());
        assert!(parse_text(&format!("{}:{}", "a".repeat(63), "b".repeat(64))).is_none());
    }
}
