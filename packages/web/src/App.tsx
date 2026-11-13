import { useEffect, useMemo, useState } from "react";
import { blockHeight, EXPLORER, getBettors, getBriefs, getIdentities, getJobs, getLeaderboard, getRounds, getScoutRecord, getTasks, isFinal, LEAGUE, short, type Bettor, type Brief, type Identity, type Job, type Rating, type Round, type ScoutRecord, type Task } from "./chain";
import { Drawer } from "./Drawer";
import { LogoMark } from "./Logo";
import { Ticker } from "./Ticker";
import { names } from "./league";
import { loadIdentityNotes, loadRecord, loadRoster, type IdentityNotes, type RosterAgent, type RoundRecord } from "./offchain";
import { Side } from "./Side";
import type { ProfileRef } from "./Profile";
import { WalletButton } from "./wallet";
import { AccountView, type AccountTab } from "./views/Account";
import { HomeView } from "./views/Home";
import { LeagueView } from "./views/League";
import { LeaderboardView } from "./views/Pages";
import { RoundView } from "./views/Round";
import { useRecheck, VerifyView } from "./views/VerifyView";

// Public RPCs rate-limit; poll gently and not at all while the tab is hidden.
const POLL_MS = 15000;

type View = "home" | "league" | "round" | "verify" | "leaderboard" | "account";
// A round, and its re-check, open from the League feed; they have no tab of their own.
const TABS: Array<[View, string]> = [
  ["home", "Home"],
  ["league", "League"],
  ["leaderboard", "Leaderboard"],
  ["account", "Account"],
];
const ACCOUNT_TABS: AccountTab[] = ["brief", "agent", "activity"];

interface Route {
  view: View;
  round: number | null;
  account: AccountTab;
}

/** #/round/12, #/verify/12, #/account/agent ... and the old #round=12. */
function parseHash(): Route {
  const h = location.hash;
  const old = /round=(\d+)/.exec(h);
  if (old) return { view: "round", round: Number(old[1]), account: "brief" };
  const m = /^#\/(home|league|round|verify|leaderboard|account)(?:\/(\w+))?/.exec(h);
  if (!m) return { view: "home", round: null, account: "brief" };
  const view = m[1] as View;
  const tail = m[2] ?? "";
  return {
    view,
    round: /^\d+$/.test(tail) ? Number(tail) : null,
    account: ACCOUNT_TABS.includes(tail as AccountTab) ? (tail as AccountTab) : "brief",
  };
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
  const [panel, setPanel] = useState(false);
  const [profile, setProfile] = useState<ProfileRef | null>(null);
  const openProfile = (p: ProfileRef | null) => {
    setProfile(p);
    if (p) setPanel(true);
  };
  const [details, setDetails] = useState(false);
  const [autoplay, setAutoplay] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRoster().then((r) => setRoster(r ?? []));
    const onHash = () => {
      setRoute(parseHash());
      setPanel(false);
      setPicked(null);
      setProfile(null);
    };
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

  const go = (view: View, round: number | null = current?.id ?? null, account: AccountTab = route.account) => {
    setPicked(null);
    setProfile(null);
    setDetails(false);
    setPanel(false);
    const hash = view === "round" || view === "verify" ? `#/${view}/${round}` : view === "account" ? `#/account/${account}` : `#/${view}`;
    if (location.hash !== hash) history.pushState(null, "", hash);
    setRoute({ view, round: view === "round" || view === "verify" ? round : route.round, account });
  };
  const pick = (agent: string | null) => {
    setPicked(agent);
    if (agent) setPanel(true);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && !details && (setPanel(false), setPicked(null));
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [details]);
  const rec = current ? records[current.id] ?? null : null;
  const entry = current && picked ? current.entries.find((e) => e.agent === picked) : undefined;

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => go("home")} aria-label="Benchmarket home">
          <LogoMark />
          <span className="brand-name">Benchmarket</span>
        </button>
        <nav className="tabs" aria-label="Views">
          {TABS.map(([id, label], i) => (
            <button key={id} aria-pressed={route.view === id || (id === "league" && (route.view === "round" || route.view === "verify"))} onClick={() => go(id)}>
              <span className="tab-n">{String(i + 1).padStart(2, "0")}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="top-end">
          <a className="top-link" href={`${EXPLORER}/address/${LEAGUE}`} target="_blank" rel="noreferrer" title="The league contract in the explorer">
            <span className="top-k">contract</span>
            {LEAGUE}
          </a>
          <span className="top-net" title="Latest optimistic block on NEAR testnet">
            <i className="dot" data-live />
            <span className="top-k">testnet</span>
            <span className="top-height">{height ? `#${height.toLocaleString("en-US")}` : "…"}</span>
          </span>
          <WalletButton />
          {route.view !== "leaderboard" && (
            <button className="top-board" aria-pressed={panel} onClick={() => (panel ? (setPanel(false), setPicked(null)) : setPanel(true))} aria-label="Toggle the standings panel">
              <span aria-hidden="true">{panel ? "[×]" : "[≡]"}</span>
              <span className="top-board-label">Standings</span>
            </button>
          )}
        </div>
      </header>
      {route.view !== "round" && route.view !== "verify" && <Ticker rounds={rounds} n={n} onOpen={(id) => go("round", id)} />}

      <div className="body">
        <main className="main" data-view={route.view}>
          {error && (
            <p className="alert" role="alert">
              Could not reach the NEAR RPC: {error}
            </p>
          )}
          {route.view === "home" && (
            <HomeView
              rounds={rounds}
              n={n}
              onReplay={(id) => {
                go("round", id);
                setAutoplay(id);
              }}
              onLeague={() => go("league")}
              onPost={() => go("account", null, "brief")}
              onEnter={() => go("account", null, "agent")}
            />
          )}
          {route.view === "league" && (
            <LeagueView
              rounds={rounds}
              records={records}
              n={n}
              onOpen={(id) => go("round", id)}
              onReplay={(id) => {
                go("round", id);
                setAutoplay(id);
              }}
              onBriefs={() => go("account", null, "agent")}
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
                onPick={pick}
                onSelect={(id) => go("round", id)}
                onLeague={() => go("league")}
                onVerify={() => go("verify", current.id)}
                autoplay={autoplay === current.id}
                onStarted={() => setAutoplay(null)}
              />
            ) : (
              <div className="empty">Loading rounds from the contract…</div>
            ))}
          {route.view === "leaderboard" && (
            <LeaderboardView
              ratings={ratings}
              rounds={rounds}
              roster={roster}
              identities={identities}
              bettors={bettors}
              records={Object.values(records).filter((r): r is RoundRecord => !!r)}
              picks={picks}
              tasks={tasks}
              onProfile={openProfile}
            />
          )}
          {route.view === "account" && (
            <AccountView tab={route.account} onTab={(t) => go("account", null, t)} briefs={briefs} jobs={jobs} identities={identities} ratings={ratings} tasks={tasks} roster={roster} onRound={(id) => go("round", id)} />
          )}
          {route.view === "verify" && <VerifyView round={current} recheck={recheck} verifiable={verifiable} onBack={() => go("round", current?.id ?? null)} />}
        </main>
      </div>

      {panel && <div className="side-scrim" onClick={() => (setPanel(false), setPicked(null), setProfile(null))} />}
      <Side
        open={panel}
          ratings={ratings}
          bettors={bettors}
          n={n}
          round={route.view === "round" ? current : null}
          rec={rec}
          picked={route.view === "round" ? picked : null}
          notes={notes}
          onClose={() => (picked ? setPicked(null) : setPanel(false))}
          onDetails={() => setDetails(true)}
          onPost={() => go("account", null, "brief")}
          profile={profile}
          profileData={{ rounds, records, ratings, bettors, picks, tasks, notes, n }}
          onRound={(id) => go("round", id)}
          onProfile={(p) => (p ? openProfile(p) : (setProfile(null), setPanel(false)))}
        />

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
