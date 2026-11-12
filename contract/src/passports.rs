//! Passport methods: issuing identities and the face uniqueness index.

use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::*;

#[near]
impl Contract {
    /// Issues the agent's passport. The face is derived here from `seed`, the agent's own
    /// self-description, and must be at least `MIN_CELLS` cells away from every issued face.
    /// Called by the agent itself, or by the owner for agents that cannot sign (Market League).
    #[payable]
    pub fn register_identity(&mut self, agent: AccountId, seed: String, motto: String, config_hash: String, proof: String) -> u32 {
        let caller = env::predecessor_account_id();
        require!(caller == agent || caller == self.owner, "only the agent or the owner can issue its identity");
        require!(env::attached_deposit().as_yoctonear() >= IDENTITY_DEPOSIT, "attach 0.02 NEAR for storage");
        require!(!self.identities.contains_key(&agent), "identity already issued");
        require!(proof.len() <= 256 && config_hash.len() <= 128, "proof or config hash too long");
        if let Err(e) = identity::validate_motto(&motto) {
            env::panic_str(&e);
        }
        let check = self.check_face(seed.clone());
        if !check.ok {
            env::panic_str(&check.reason.unwrap_or_else(|| "face rejected".into()));
        }
        let number = self.next_identity;
        self.next_identity += 1;
        let face = identity::Face { cells: check.cells.clone(), palette: check.palette };
        let id = Identity {
            number,
            seed,
            cells: check.cells,
            palette: check.palette,
            motto: motto.trim().to_string(),
            config_hash,
            proof,
            issuer: caller,
            issued_at_ms: env::block_timestamp_ms(),
        };
        self.identities.insert(agent.clone(), id);
        self.index_face(identity::pack(&face.cells), number, agent.clone());
        emit(
            "identity_issued",
            json!({
                "agent": agent,
                "number": number,
                "cells": face.cells,
                "palette": face.palette,
                "face_code": identity::face_code(&face),
                "motto": motto.trim(),
            }),
        );
        number
    }

    /// The face this seed would produce and whether it would be accepted.
    pub fn check_face(&self, seed: String) -> FaceCheck {
        let seed_ok = identity::validate_seed(&seed);
        let face = if seed_ok.is_ok() { identity::derive(&seed) } else { identity::Face { cells: vec![], palette: [0; 3] } };
        let reject = |reason: String, face: identity::Face| FaceCheck {
            ok: false,
            reason: Some(reason),
            cells: face.cells,
            palette: face.palette,
            nearest: None,
            distance: None,
        };
        if let Err(e) = seed_ok {
            return reject(e, face);
        }
        if let Err(e) = identity::validate_fill(&face.cells) {
            return reject(e, face);
        }
        let nearest = self
            .nearest_face(identity::pack(&face.cells))
            .and_then(|(n, d)| self.agent_by_number.get(&n).map(|a| (a.clone(), d)));
        let clash = nearest.as_ref().filter(|(_, d)| *d < identity::MIN_CELLS);
        FaceCheck {
            ok: clash.is_none(),
            reason: clash.map(|(a, d)| format!("face too close to {a}: {d} cells apart, needs {}", identity::MIN_CELLS)),
            cells: face.cells,
            palette: face.palette,
            distance: nearest.as_ref().map(|n| n.1),
            nearest: nearest.map(|n| n.0),
        }
    }

    /// Number of faces in the uniqueness index (equals the number of issued passports).
    pub fn face_count(&self) -> u32 {
        self.face_pages.iter().map(|p| p.len() as u32).sum()
    }

    pub fn get_identity(&self, agent: AccountId) -> Option<IdentityView> {
        self.identities.get(&agent).map(|id| identity_view(&agent, id))
    }

    pub fn get_identities(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<IdentityView> {
        self.identities
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(a, id)| identity_view(a, id))
            .collect()
    }
}

impl Contract {
    pub(crate) fn index_face(&mut self, packed: u64, number: u32, agent: AccountId) {
        let len = self.face_pages.len();
        match self.face_pages.get_mut(len.wrapping_sub(1)) {
            Some(page) if page.len() < identity::PAGE => page.push(packed),
            _ => self.face_pages.push(vec![packed]),
        }
        self.agent_by_number.insert(number, agent);
    }

    /// Closest issued face: (passport number, cells apart). Stops early on an exact repeat.
    pub(crate) fn nearest_face(&self, packed: u64) -> Option<(u32, u32)> {
        let mut best: Option<(u32, u32)> = None;
        let mut number = 0u32;
        for page in self.face_pages.iter() {
            for f in page {
                number += 1;
                let d = identity::packed_apart(packed, *f);
                if best.map_or(true, |(_, b)| d < b) {
                    best = Some((number, d));
                    if d == 0 {
                        return best;
                    }
                }
            }
        }
        best
    }
}
