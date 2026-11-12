//! Agent identity ("passport"): a face the agent picks for itself from a fixed grammar.
//!
//! A face is seven slot values: head, top, eyes, nose, mouth, ears, hue. The catalogs that
//! turn slot values into ASCII live off chain (packages/shared/src/identity.ts); the contract
//! only needs the slot sizes to validate a face and compare it with every face issued so far.
//!
//! Uniqueness rule: a new face must differ from every existing face in at least
//! `MIN_DISTANCE` slots, and at least `MIN_SHAPE_DISTANCE` of those must be shape slots
//! (everything except hue), so a recolor of someone else's face is never accepted.

/// Number of options per slot: head, top, eyes, nose, mouth, ears, hue.
pub const FACE_SLOTS: [u8; 7] = [6, 8, 10, 6, 10, 6, 10];
pub const SHAPE_SLOTS: usize = 6;
pub const MIN_DISTANCE: u8 = 3;
pub const MIN_SHAPE_DISTANCE: u8 = 2;
pub const MAX_MOTTO: usize = 64;

pub fn validate_face(face: &[u8]) -> Result<(), String> {
    if face.len() != FACE_SLOTS.len() {
        return Err(format!("face must have {} slots", FACE_SLOTS.len()));
    }
    for (i, (v, n)) in face.iter().zip(FACE_SLOTS.iter()).enumerate() {
        if v >= n {
            return Err(format!("slot {i} out of range: {v} >= {n}"));
        }
    }
    Ok(())
}

/// (all-slot distance, shape-slot distance).
pub fn distance(a: &[u8], b: &[u8]) -> (u8, u8) {
    let mut all = 0;
    let mut shape = 0;
    for i in 0..FACE_SLOTS.len() {
        if a.get(i) != b.get(i) {
            all += 1;
            if i < SHAPE_SLOTS {
                shape += 1;
            }
        }
    }
    (all, shape)
}

pub fn distinct_enough(a: &[u8], b: &[u8]) -> bool {
    let (all, shape) = distance(a, b);
    all >= MIN_DISTANCE && shape >= MIN_SHAPE_DISTANCE
}

pub fn validate_motto(motto: &str) -> Result<(), String> {
    let m = motto.trim();
    if m.is_empty() || m.len() > MAX_MOTTO {
        return Err(format!("motto must be 1..={MAX_MOTTO} characters"));
    }
    if !m.chars().all(|c| (' '..='~').contains(&c)) {
        return Err("motto must be printable ASCII".into());
    }
    Ok(())
}

/// Canonical text form, e.g. `h2-t5-e7-n1-m3-a2-c4`.
pub fn face_code(face: &[u8]) -> String {
    const TAGS: [char; 7] = ['h', 't', 'e', 'n', 'm', 'a', 'c'];
    face.iter().zip(TAGS.iter()).map(|(v, t)| format!("{t}{v}")).collect::<Vec<_>>().join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ranges() {
        assert!(validate_face(&[0, 0, 0, 0, 0, 0, 0]).is_ok());
        assert!(validate_face(&[5, 7, 9, 5, 9, 5, 9]).is_ok());
        assert!(validate_face(&[6, 0, 0, 0, 0, 0, 0]).is_err());
        assert!(validate_face(&[0, 0, 0]).is_err());
    }

    #[test]
    fn recolor_is_not_distinct() {
        let a = [1, 2, 3, 4, 5, 1, 0];
        // Same shape, other hue: distance 1.
        assert!(!distinct_enough(&a, &[1, 2, 3, 4, 5, 1, 7]));
        // Two shape slots and the hue: accepted.
        assert!(distinct_enough(&a, &[1, 2, 9, 4, 0, 1, 7]));
        // Ears and hue only: two slots, one of them shape. Rejected.
        assert_eq!(distance(&a, &[1, 2, 3, 4, 5, 3, 7]), (2, 1));
        assert!(!distinct_enough(&a, &[1, 2, 3, 4, 5, 3, 7]));
        // Three shape slots, same hue: accepted.
        assert!(distinct_enough(&a, &[0, 0, 0, 4, 5, 1, 0]));
    }

    #[test]
    fn motto_rules() {
        assert!(validate_motto("Spec first, code second.").is_ok());
        assert!(validate_motto("   ").is_err());
        assert!(validate_motto(&"x".repeat(65)).is_err());
        assert!(validate_motto("caf\u{e9}").is_err());
    }

    #[test]
    fn code_format() {
        assert_eq!(face_code(&[2, 5, 7, 1, 3, 2, 4]), "h2-t5-e7-n1-m3-a2-c4");
    }
}
