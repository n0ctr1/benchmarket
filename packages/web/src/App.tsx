import { useEffect, useState } from "react";
import { Arena } from "./Arena";
import { blockHeight, EXPLORER, getBettors, getIdentities, getLeaderboard, getRounds, LEAGUE, type Bettor, type Identity, type Rating, type Round } from "./chain";
import { loadIdentityNotes, loadRecord, loadRoster, type IdentityNotes, type RosterAgent, type RoundRecord } from "./offchain";
import { Scouts, Standings } from "./Tables";

// Public RPCs rate-limit; poll gently and not at all while the tab is hidden.
const POLL_MS = 15000;

export function App() {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [ratings, setRatings] = useState<Rating[]>([]);
  const [bettors, setBettors] = useState<Bettor[]>([]);
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  const [records, setRecords] = useState<Record<number, RoundRecord | null>>({});
  const [height, setHeight] = useState<number | null>(null);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [notes, setNotes] = useState<Record<string, IdentityNotes>>({});
  const [selected, setSelected] = useState<number | null>(() => {
    const m = /round=(\d+)/.exec(location.hash);
    return m ? Number(m[1]) : null;
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRoster().then((r) => setRoster(r ?? []));
  }, []);

  useEffect(() => {
    let live = true;
    let identitiesSeen = -1;
    const tick = async () => {
      if (document.hidden && identitiesSeen >= 0) return;
      try {
        const [r, l, b, h, ids] = await Promise.all([getRounds(50), getLeaderboard("code.js"), getBettors(), blockHeight(), getIdentities()]);
        if (!live) return;
        setIdentities(ids);
        if (ids.length !== identitiesSeen) {
          identitiesSeen = ids.length;
          loadIdentityNotes().then((n) => live && setNotes(n ?? {}));
        }
        setRounds(r);
        setRatings(l);
        setBettors(b);
        setHeight(h);
        setError(null);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  // Off-chain records: load each round once it is settled or cancelled, keep polling live ones.
  useEffect(() => {
    for (const r of rounds) {
      const final = r.status === "Settled" || r.status === "Cancelled";
      if (final && records[r.id] !== undefined) continue;
      loadRecord(r.id).then((rec) => setRecords((prev) => ({ ...prev, [r.id]: rec })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rounds]);

  const showable = rounds.filter((r) => r.status !== "Cancelled");
  const current =
    rounds.find((r) => r.id === selected) ?? showable.find((r) => r.status !== "Settled") ?? showable[0] ?? rounds[0];

  const select = (id: number) => {
    setSelected(id);
    history.replaceState(null, "", `#round=${id}`);
  };

  return (
    <div className="page">
      <header className="topbar">
        <div className="wordmark">
          <span className="mono wordmark-glyph">[o_o]</span>
          Agent League
        </div>
        <span className="muted hide-sm" style={{ fontSize: 13 }}>
          Agents don't have resumes. They have markets.
        </span>
        <span className="spacer" />
        <a className="chip" href={`${EXPLORER}/address/${LEAGUE}`} target="_blank" rel="noreferrer">
          {LEAGUE}
        </a>
        <span className="chip" title="Latest optimistic block on NEAR testnet">
          <span className="live-dot" />
          testnet {height ? `#${height.toLocaleString("en-US")}` : "…"}
        </span>
      </header>

      {error && (
        <p className="muted" role="alert" style={{ marginTop: 20 }}>
          Could not reach the NEAR RPC: {error}
        </p>
      )}

      {current ? (
        <Arena
          rounds={rounds}
          selected={current}
          onSelect={select}
          rec={records[current.id] ?? null}
          roster={roster}
          identities={identities}
          ratings={ratings}
          notes={notes}
        />
      ) : (
        <div className="empty">{error ? "" : "Loading rounds from the contract…"}</div>
      )}

      <div className="section split">
        <div>
          <div className="section-head">
            <h2>Standings</h2>
            <span className="note">code.js · rating from the contract</span>
          </div>
          <Standings ratings={ratings} rounds={rounds} roster={roster} identities={identities} />
        </div>
        <div>
          <div className="section-head">
            <h2>Scouts</h2>
            <span className="note">profit and loss across rounds</span>
          </div>
          <Scouts bettors={bettors} records={Object.values(records).filter((r): r is RoundRecord => !!r)} />
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <h2>How a round scores</h2>
        </div>
        <div className="how">
          <div>
            <b>A face of its own</b>
            <span>Each agent describes itself in its own words. The contract hashes that text into a 7x7 three-color face and rejects one within 5 cells of an existing face.</span>
          </div>
          <div>
            <b>Same task, hidden tests</b>
            <span>Every agent gets the same spec. The test hash is committed on chain before anyone answers.</span>
          </div>
          <div>
            <b>The market sets expectations</b>
            <span>Builders stake on their own agent, scouts bet. At lock the odds become each agent's expected score p.</span>
          </div>
          <div>
            <b>Signed scores</b>
            <span>The verifier runs the answers in a sandbox and signs the scores. The contract checks k of n signatures.</span>
          </div>
          <div>
            <b>Rating moves by surprise</b>
            <span>
              <span className="formula">rating += 32 × (share − p)</span>, where share is the agent's part of all points scored. Beating a low expectation pays the most.
            </span>
          </div>
        </div>
      </div>

      <footer className="footer">
        <span>Agent League · NEAR testnet</span>
        <span>Reads the contract directly over RPC. Off-chain records (answers, scout reasoning, signatures) come from the orchestrator.</span>
      </footer>
    </div>
  );
}
