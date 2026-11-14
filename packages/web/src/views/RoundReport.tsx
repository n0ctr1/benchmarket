import { useState } from "react";
import { EXPLORER, LEAGUE, near, short, type Round } from "../chain";
import type { Names } from "../league";
import type { RoundRecord } from "../offchain";

const ppm = (v: number) => `${(v / 10_000).toFixed(1)}%`;
const hash = (h: string | null | undefined, n = 12) => (h ? `${h.replace(/^sha256:/, "").slice(0, n)}…` : "—");

/**
 * The round as plain tables, for a quick check without the stage: every bet with its price
 * move, every entrant with its commitment, model, score and rating change, and the signed
 * result. "Copy proof" puts the same facts, with where to verify each, on the clipboard.
 */
export function RoundReport({ round, rec, n }: { round: Round; rec: RoundRecord | null; n: Names }) {
  const [copied, setCopied] = useState(false);
  const bets = (rec?.events ?? []).filter((e) => e.kind === "scout_bet");
  const total = rec?.report?.totalTests ?? round.total_tests;
  const scores = new Map(round.proposal?.scores ?? []);

  const proof = () => ({
    contract: LEAGUE,
    round: round.id,
    task: round.task_ref,
    tests_hash: round.tests_hash,
    status: round.status,
    total_tests: total,
    entries: round.entries.map((e) => ({
      agent: e.agent,
      config_hash: e.config_hash,
      answer_hash: e.answer_hash,
      attested: e.attested,
      model: e.model,
      expected_ppm: e.p_ppm,
      score: e.score ?? scores.get(e.agent) ?? null,
      rating_delta: e.rating_delta,
    })),
    verifier: rec?.report ? { message: rec.report.message, signatures: rec.report.signatures } : null,
    dispute: round.dispute ?? null,
    check: {
      chain: `get_round {"round_id":${round.id}} on ${LEAGUE}`,
      explorer: `${EXPLORER}/address/${LEAGUE}`,
      published_report: `${location.origin}${location.pathname.replace(/[^/]*$/, "")}data/reports/${round.id}.json`,
      recheck: `${location.origin}${location.pathname}#/verify/${round.id}`,
    },
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(proof(), null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="report">
      <div className="report-head">
        <span className="report-k">Round {round.id} as tables</span>
        <span className="report-actions">
          <a className="btn btn-line" href={`${EXPLORER}/address/${LEAGUE}`} target="_blank" rel="noreferrer">
            Explorer
          </a>
          <button className="btn btn-accent" onClick={copy} data-tour="copy-proof" title="Copy every hash, score and signature of this round as JSON">
            {copied ? "Copied" : "Copy proof"}
          </button>
        </span>
      </div>

      <h3 className="report-h">Entrants</h3>
      <div className="report-scroll">
        <table className="report-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Model</th>
              <th>Expected</th>
              <th>Answer hash</th>
              <th>Attested</th>
              <th>Score</th>
              <th>Rating</th>
            </tr>
          </thead>
          <tbody>
            {round.entries.map((e) => {
              const s = e.score ?? scores.get(e.agent) ?? null;
              const win = round.winners.includes(e.agent);
              return (
                <tr key={e.agent} data-win={win}>
                  <td>{n.name(e.agent)}</td>
                  <td className="mono">{e.model ?? rec?.agents[e.agent]?.meta?.model ?? "—"}</td>
                  <td className="mono">{ppm(e.p_ppm)}</td>
                  <td className="mono" title={e.answer_hash ?? ""}>{hash(e.answer_hash)}</td>
                  <td>{e.attested ? "yes" : "no"}</td>
                  <td className="mono">{s === null ? "—" : `${s}/${total}`}</td>
                  <td className="mono">{e.rating_delta ? `${e.rating_delta > 0 ? "+" : ""}${(e.rating_delta / 100).toFixed(1)}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="report-h">Market ({bets.length} bets)</h3>
      {bets.length === 0 ? (
        <p className="report-note">No bets in this round: expected scores came from ratings alone.</p>
      ) : (
        <div className="report-scroll">
          <table className="report-table">
            <thead>
              <tr>
                <th>Scout</th>
                <th>Bought</th>
                <th>Amount</th>
                <th>Price</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {bets.map((b, i) => (
                <tr key={i}>
                  <td className="mono">{short(String(b.data.scout))}</td>
                  <td>{n.name(String(b.data.agent))}</td>
                  <td className="mono">{near(String(b.data.amount))} NEAR</td>
                  <td className="mono">
                    {b.data.price_before !== undefined ? `${(Number(b.data.price_before) * 100).toFixed(1)}%` : "—"}
                    {b.data.price_after_ppm ? ` to ${ppm(Number(b.data.price_after_ppm))}` : ""}
                  </td>
                  <td className="report-why">{String(b.data.reasoning ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="report-h">Signed result</h3>
      <dl className="report-dl">
        <dt>Tests hash</dt>
        <dd className="mono">{hash(round.tests_hash, 24)}</dd>
        <dt>Verifier message</dt>
        <dd className="mono">{rec?.report?.message ?? "not scored yet"}</dd>
        <dt>Signatures</dt>
        <dd className="mono">{rec?.report ? `${rec.report.signatures.length} (threshold on chain; Re-check verifies each)` : "—"}</dd>
        {round.dispute && (
          <>
            <dt>Dispute</dt>
            <dd className="mono">
              by {short(round.dispute.by)}, {round.dispute.overturned ? "overturned: the signing keys were slashed" : round.dispute.overturned === false ? "upheld" : "pending"}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
