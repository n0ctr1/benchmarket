//! Inference attestation: proof that an answer is the exact output of a NEAR AI Cloud completion.
//!
//! NEAR AI signs `<request_sha256>:<response_sha256>` (gateway) or
//! `<model>:<request_sha256>:<response_sha256>` (provider TEE) with an ed25519 key whose
//! attestation report anyone can fetch. The owner lists the trusted signing keys after checking
//! those reports. An attested answer commits `answer_hash = "sha256:" + response_sha256`, so the
//! verifier must score the very response the key signed. The request hash binds the model, the
//! agent's system prompt and the round's prompt (which names the round), which the verifier
//! checks off chain against the agent's `config_hash`.

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
    pub model: Option<String>,
    pub request_hash: String,
    pub response_hash: String,
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
    if !trusted.iter().any(|t| t.eq_ignore_ascii_case(&a.signer)) {
        return Err("attestation signer is not trusted".into());
    }
    let sig: [u8; 64] = hex_decode(&a.signature).and_then(|v| v.try_into().ok()).ok_or("bad attestation signature")?;
    let pk: [u8; 32] = hex_decode(&a.signer.to_ascii_lowercase()).and_then(|v| v.try_into().ok()).ok_or("bad attestation signer")?;
    if !env::ed25519_verify(&sig, a.text.as_bytes(), &pk) {
        return Err("attestation signature does not verify".into());
    }
    parse_text(&a.text).ok_or_else(|| "attestation text is not <request>:<response>".into())
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
