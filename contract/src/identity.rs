//! Agent identity ("passport"): an abstract face, like a GitHub identicon.
//!
//! The agent writes a short self-description (its `seed`). The contract hashes it and derives
//! a 5x5 mirrored pattern (15 free cells) and a hue, so the face is a pure function of the
//! agent's own words and nobody can pick someone else's face. A pattern is accepted only if it
//! differs from every issued pattern in at least `MIN_BITS` cells; the agent rewrites its
//! seed otherwise. The renderer lives in packages/shared/src/identity.ts.

use near_sdk::env;

pub const DOMAIN: &str = "agent-league:face:v1:";
pub const CELLS: u32 = 15;
pub const MIN_BITS: u32 = 3;
pub const MIN_FILL: u32 = 4;
pub const MAX_FILL: u32 = 11;
pub const MIN_SEED: usize = 20;
pub const MAX_SEED: usize = 400;
pub const MAX_MOTTO: usize = 64;

/// (pattern, hue) for a seed. Bit `row * 3 + col` is the cell in column `col` (0..3) of `row`;
/// columns 3 and 4 mirror columns 1 and 0.
pub fn derive(seed: &str) -> (u16, u16) {
    let mut input = DOMAIN.as_bytes().to_vec();
    input.extend_from_slice(seed.as_bytes());
    let h = env::sha256_array(&input);
    let pattern = (h[0] as u16 | ((h[1] as u16) << 8)) & 0x7fff;
    let hue = ((h[2] as u16) << 8 | h[3] as u16) % 360;
    (pattern, hue)
}

pub fn bits_apart(a: u16, b: u16) -> u32 {
    (a ^ b).count_ones()
}

fn printable(s: &str) -> bool {
    s.chars().all(|c| (' '..='~').contains(&c))
}

pub fn validate_seed(seed: &str) -> Result<(), String> {
    if seed.len() < MIN_SEED || seed.len() > MAX_SEED {
        return Err(format!("seed must be {MIN_SEED}..={MAX_SEED} characters"));
    }
    if !printable(seed) || seed.trim() != seed {
        return Err("seed must be printable ASCII without leading or trailing spaces".into());
    }
    Ok(())
}

/// Very sparse or very full patterns read as noise, not a face.
pub fn validate_pattern(pattern: u16) -> Result<(), String> {
    let fill = (pattern as u32).count_ones();
    if !(MIN_FILL..=MAX_FILL).contains(&fill) {
        return Err(format!("pattern has {fill} of {CELLS} cells filled, needs {MIN_FILL}..={MAX_FILL}"));
    }
    Ok(())
}

pub fn validate_motto(motto: &str) -> Result<(), String> {
    let m = motto.trim();
    if m.is_empty() || m.len() > MAX_MOTTO {
        return Err(format!("motto must be 1..={MAX_MOTTO} characters"));
    }
    if !printable(m) {
        return Err("motto must be printable ASCII".into());
    }
    Ok(())
}

/// Text form used in events and views, e.g. `5a3c-212` (pattern hex, hue).
pub fn face_code(pattern: u16, hue: u16) -> String {
    format!("{pattern:04x}-{hue:03}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    #[test]
    fn derive_matches_the_typescript_renderer() {
        testing_env!(VMContextBuilder::new().build());
        // Same vector as packages/orchestrator/test/identity.test.ts.
        assert_eq!(derive("I read the spec twice and test the edges first."), EXPECTED_VECTOR);
    }

    // Computed by the TypeScript implementation; both sides must agree.
    const EXPECTED_VECTOR: (u16, u16) = (21617, 60);

    #[test]
    fn distance_and_fill() {
        assert_eq!(bits_apart(0b101, 0b011), 2);
        assert!(validate_pattern(0b1111).is_ok());
        assert!(validate_pattern(0b111).is_err());
        assert!(validate_pattern(0x7fff).is_err());
    }

    #[test]
    fn seed_and_motto_rules() {
        assert!(validate_seed("A careful agent that reads the spec.").is_ok());
        assert!(validate_seed("too short").is_err());
        assert!(validate_seed(" leading space is not allowed here").is_err());
        assert!(validate_seed("caf\u{e9} is not ascii but long enough").is_err());
        assert!(validate_motto("Spec first.").is_ok());
        assert!(validate_motto(&"x".repeat(65)).is_err());
        assert_eq!(face_code(0x5a3c, 7), "5a3c-007");
    }
}
