//! Agent identity ("passport"): an abstract face, like a GitHub identicon, but bigger and in
//! three colors.
//!
//! The agent writes a short self-description (its `seed`). The contract hashes it and derives a
//! 7x7 grid mirrored left to right (28 free cells), each cell off or lit in one of three
//! palette colors, plus the palette itself. The face is a pure function of the agent's own
//! words, so nobody can pick someone else's face. A face is accepted only if it differs from
//! every issued face in at least `MIN_CELLS` cells; the agent rewrites its seed otherwise.
//! The renderer lives in packages/shared/src/identity.ts.

use near_sdk::env;

pub const DOMAIN: &str = "agent-league:face:v2:";
pub const SIZE: usize = 7;
/// Free columns per row: 0..=3, the rest mirror them.
pub const HALF: usize = 4;
pub const CELLS: usize = SIZE * HALF;
pub const MIN_CELLS: u32 = 6;
pub const MIN_FILL: u32 = 8;
pub const MAX_FILL: u32 = 21;
pub const MIN_SEED: usize = 20;
pub const MAX_SEED: usize = 400;
pub const MAX_MOTTO: usize = 64;

/// A derived face: `cells[row * 4 + col]` is 0 (off) or 1..=3 (palette color); `palette` holds
/// three hues in degrees.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Face {
    pub cells: Vec<u8>,
    pub palette: [u16; 3],
}

/// Reads `n` bits starting at bit `pos` of `bytes`, least significant bit first.
fn bits(bytes: &[u8], pos: usize, n: usize) -> u32 {
    (0..n).map(|i| (((bytes[(pos + i) / 8] >> ((pos + i) % 8)) & 1) as u32) << i).sum()
}

pub fn derive(seed: &str) -> Face {
    let mut input = DOMAIN.as_bytes().to_vec();
    input.extend_from_slice(seed.as_bytes());
    let h = env::sha256_array(&input);
    let base = ((h[0] as u16) << 8 | h[1] as u16) % 360;
    // An analogous accent (40..119 degrees away) and a near-complement (150..209 away).
    let second = (base + 40 + h[2] as u16 % 80) % 360;
    let third = (base + 150 + h[3] as u16 % 60) % 360;
    // Three bits per cell from byte 4 on: half the values are off, then 1/4, 1/8, 1/8.
    let cells = (0..CELLS)
        .map(|i| match bits(&h[4..], i * 3, 3) {
            0..=3 => 0,
            4 | 5 => 1,
            6 => 2,
            _ => 3,
        })
        .collect();
    Face { cells, palette: [base, second, third] }
}

/// Faces per storage page of the face index.
pub const PAGE: usize = 1024;

/// Two bits per cell, cell `i` at bits `2i..2i+1` (same packing as `face_code`).
pub fn pack(cells: &[u8]) -> u64 {
    cells.iter().enumerate().map(|(i, c)| (*c as u64 & 3) << (i * 2)).sum()
}

const LOW_BITS: u64 = 0x0055_5555_5555_5555; // bit 0 of each of the 28 cells

/// Number of cells whose value differs, on packed faces.
pub fn packed_apart(a: u64, b: u64) -> u32 {
    let x = a ^ b;
    ((x | (x >> 1)) & LOW_BITS).count_ones()
}

pub fn cells_apart(a: &[u8], b: &[u8]) -> u32 {
    a.iter().zip(b.iter()).filter(|(x, y)| x != y).count() as u32
}

pub fn fill(cells: &[u8]) -> u32 {
    cells.iter().filter(|c| **c != 0).count() as u32
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

/// Very sparse or very full grids read as noise, not a face.
pub fn validate_fill(cells: &[u8]) -> Result<(), String> {
    let n = fill(cells);
    if !(MIN_FILL..=MAX_FILL).contains(&n) {
        return Err(format!("face has {n} of {CELLS} cells lit, needs {MIN_FILL}..={MAX_FILL}"));
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

/// Text form: the cells packed two bits each as hex (14 digits), then the base hue.
pub fn face_code(face: &Face) -> String {
    let packed: u64 = face.cells.iter().enumerate().map(|(i, c)| (*c as u64) << (i * 2)).sum();
    format!("{packed:014x}-{:03}", face.palette[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    // Computed by the TypeScript implementation; both sides must agree.
    const VECTOR_SEED: &str = "I read the spec twice and test the edges first.";
    const VECTOR_CODE: &str = "81302104025327-315/18/141";

    #[test]
    fn derive_matches_the_typescript_renderer() {
        testing_env!(VMContextBuilder::new().build());
        let f = derive(VECTOR_SEED);
        assert_eq!(f.cells.len(), CELLS);
        assert!(f.cells.iter().all(|c| *c <= 3));
        assert_eq!(format!("{}/{}/{}", face_code(&f), f.palette[1], f.palette[2]), VECTOR_CODE);
    }

    #[test]
    fn packed_distance_matches_cell_distance() {
        testing_env!(VMContextBuilder::new().build());
        let faces: Vec<Vec<u8>> = (0..200).map(|i| derive(&format!("seed number {i} for packing")).cells).collect();
        for a in &faces {
            for b in faces.iter().take(40) {
                assert_eq!(packed_apart(pack(a), pack(b)), cells_apart(a, b));
            }
        }
        assert_eq!(packed_apart(pack(&[3; 28]), 0), 28);
    }

    #[test]
    fn distance_and_fill() {
        assert_eq!(cells_apart(&[0, 1, 2, 3], &[0, 1, 3, 0]), 2);
        assert!(validate_fill(&[1; 8]).is_ok());
        assert!(validate_fill(&[1; 7]).is_err());
        assert!(validate_fill(&[2; 22]).is_err());
    }

    #[test]
    fn seed_and_motto_rules() {
        assert!(validate_seed("A careful agent that reads the spec.").is_ok());
        assert!(validate_seed("too short").is_err());
        assert!(validate_seed(" leading space is not allowed here").is_err());
        assert!(validate_seed("caf\u{e9} is not ascii but long enough").is_err());
        assert!(validate_motto("Spec first.").is_ok());
        assert!(validate_motto(&"x".repeat(65)).is_err());
        let f = Face { cells: vec![1, 2, 3], palette: [7, 0, 0] };
        assert_eq!(face_code(&f), "00000000000039-007");
    }
}
