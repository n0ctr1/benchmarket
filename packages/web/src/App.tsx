import { useEffect, useMemo, useState } from "react";
import { blockHeight, EXPLORER, getBettors, getBriefs, getIdentities, getJobs, getLeaderboard, getRounds, getScoutRecord, getTasks, isFinal, LEAGUE, short, type Bettor, type Brief, type Identity, type Job, type Rating, type Round, type ScoutRecord, type Task } from "./chain";
import { Drawer } from "./Drawer";
import { names } from "./league";
import { loadIdentityNotes, loadRecord, loadRoster, type IdentityNotes, type RosterAgent, type RoundRecord } from "./offchain";
import { Side } from "./Side";
import { sfx } from "./sound";
import { SoundControl } from "./SoundControl";
import { LeagueView } from "./views/League";
import { BriefsView, StandingsView } from "./views/Pages";
import { RoundView } from "./views/Round";
import { recheckSummary, useRecheck, VerifyView } from "./views/VerifyView";

// Public RPCs rate-limit; poll gently and not at all while the tab is hidden.
const POLL_MS = 15000;

type View = "league" | "round" | "standings" | "briefs" | "verify";
const TABS: Array<[View, string]> = [
  ["league", "League"],
  ["round", "Round"],
  ["standings", "Standings"],
  ["briefs", "Briefs"],
  ["verify", "Verify"],
];

/** #/round/12, #/verify/12, #/standings ... and the old #round=12. */
function parseHash(): { view: View; round: number | null } {
  const h = location.hash;
  const old = /round=(\d+)/.exec(h);
  if (old) return { view: "round", round: Number(old[1]) };
  const m = /^#\/(league|round|standings|briefs|verify)(?:\/(\d+))?/.exec(h);
  if (!m) return { view: "league", round: null };
  return { view: m[1] as View, round: m[2] ? Number(m[2]) : null };
}

export function App() {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [ratings, setRatings] = useState<Rating[]>([]);
  const [bettors, setBettors] = useState<Bettor[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [picks, setPicks] = useState<Record<string, ScoutRecord | null>>({});
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  const [records, setRecords] = useState<Record<number, RoundRecord | null>>({});
  const [height, setHeight] = useState<number | null>(null);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [notes, setNotes] = useState<Record<string, IdentityNotes>>({});
  const [route, setRoute] = useState(parseHash);
  const [picked, setPicked] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [autoplay, setAutoplay] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRoster().then((r) => setRoster(r ?? []));
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let live = true;
    let identitiesSeen = -1;
    const tick = async () => {
      if (document.hidden && identitiesSeen >= 0) return;
      try {
        const [r, l, b, h, ids, t, j, br] = await Promise.all([getRounds(50), getLeaderboard("code.js"), getBettors(), blockHeight(), getIdentities(), getTasks(), getJobs(), getBriefs()]);
        if (!live) return;
        setBriefs(br);
        const scouts = [...new Set(br.flatMap((x) => x.nominations.map((nn) => nn.scout)))];
        Promise.all(scouts.map(async (s) => [s, await getScoutRecord(s)] as const)).then((rows) => live && setPicks(Object.fromEntries(rows)));
        setIdentities(ids);
        if (ids.length !== identitiesSeen) {
          identitiesSeen = ids.length;
          loadIdentityNotes().then((x) => live && setNotes(x ?? {}));
        }
        setRounds(r);
        setRatings(l);
        setBettors(b);
        setTasks(t);
        setJobs(j);
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

  // Off-chain records: load each round once it is final, keep polling live ones.
  useEffect(() => {
    for (const r of rounds) {
      if (isFinal(r) && records[r.id] !== undefined) continue;
      loadRecord(r.id).then((rec) => setRecords((prev) => ({ ...prev, [r.id]: rec })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rounds]);

  const n = useMemo(() => names(roster, identities), [roster, identities]);
  const showable = rounds.filter((r) => r.status !== "Cancelled");
  const current = rounds.find((r) => r.id === route.round) ?? showable.find((r) => r.status !== "Settled") ?? showable[0] ?? rounds[0] ?? null;
  const verifiable = !!current && (current.status === "Settled" || current.status === "Proposed" || current.status === "Disputed");
  const recheck = useRecheck(current, route.view === "verify" && verifiable);
  const sum = recheckSummary(recheck);
  const recheckLabel = recheck.state === "done" ? `${sum.passed}/${sum.total}` : "→";

  const go = (view: View, round: number | null = current?.id ?? null) => {
    setPicked(null);
    setDetails(false);
    const hash = view === "round" || view === "verify" ? `#/${view}/${round}` : `#/${view}`;
    if (location.hash !== hash) history.pushState(null, "", hash);
    setRoute({ view, round: view === "round" || view === "verify" ? round : route.round });
  };
  const rec = current ? records[current.id] ?? null : null;
  const entry = current && picked ? current.entries.find((e) => e.agent === picked) : undefined;

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => go("league")}>
          <span className="brand-mark" aria-hidden="true">
            <i data-on /> <i /> <i data-on /> <i data-on /> <i data-on /> <i data-on />
          </span>
          Agent League
        </button>
        <nav className="tabs" aria-label="Views">
          {TABS.map(([id, label]) => (
            <button key={id} aria-pressed={route.view === id} onClick={() => go(id)}>
              {label}
            </button>
          ))}
        </nav>
        <span className="grow" />
        <a className="top-link" href={`${EXPLORER}/address/${LEAGUE}`} target="_blank" rel="noreferrer">
          {LEAGUE}
        </a>
        <SoundControl />
        <span className="top-net" title="Latest optimistic block on NEAR testnet">
          <i className="dot" data-live />
          testnet {height ? `#${height.toLocaleString("en-US")}` : "…"}
        </span>
      </header>

      <div className="body">
        <main className="main" data-view={route.view}>
          {error && (
            <p className="alert" role="alert">
              Could not reach the NEAR RPC: {error}
            </p>
          )}
          {route.view === "league" && (
            <LeagueView
              rounds={rounds}
              records={records}
              n={n}
              onOpen={(id) => go("round", id)}
              onReplay={(id) => {
                sfx.unlock();
                go("round", id);
                setAutoplay(id);
              }}
              onBriefs={() => go("briefs")}
            />
          )}
          {route.view === "round" &&
            (current ? (
              <RoundView
                key={current.id}
                round={current}
                rounds={rounds}
                rec={rec}
                n={n}
                picked={picked}
                onPick={setPicked}
                onSelect={(id) => go("round", id)}
                onLeague={() => go("league")}
                autoplay={autoplay === current.id}
                onStarted={() => setAutoplay(null)}
              />
            ) : (
              <div className="empty">Loading rounds from the contract…</div>
            ))}
          {route.view === "standings" && (
            <StandingsView
              ratings={ratings}
              rounds={rounds}
              roster={roster}
              identities={identities}
              bettors={bettors}
              records={Object.values(records).filter((r): r is RoundRecord => !!r)}
              picks={picks}
              tasks={tasks}
            />
          )}
          {route.view === "briefs" && <BriefsView briefs={briefs} jobs={jobs} identities={identities} onRound={(id) => go("round", id)} />}
          {route.view === "verify" && <VerifyView round={current} recheck={recheck} verifiable={verifiable} />}
        </main>

        <Side
          view={route.view}
          ratings={ratings}
          bettors={bettors}
          n={n}
          round={route.view === "round" ? current : null}
          rec={rec}
          picked={route.view === "round" ? picked : null}
          notes={notes}
          recheckLabel={recheckLabel}
          onClose={() => setPicked(null)}
          onDetails={() => setDetails(true)}
          onBriefs={() => go("briefs")}
          onVerify={() => go("verify")}
        />
      </div>

      {details && current && entry && (
        <Drawer
          round={current}
          entry={entry}
          answer={rec?.agents[entry.agent]}
          agent={roster.find((r) => r.id === short(entry.agent))}
          identity={n.identity(entry.agent)}
          notes={notes[entry.agent]}
          onClose={() => setDetails(false)}
        />
      )}
    </div>
  );
}
