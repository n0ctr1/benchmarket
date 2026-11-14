import { useEffect, useState } from "react";
import { PAYOUT_ASSETS, payoutQuote, type PayoutQuote } from "@benchmarket/shared/intents";

/**
 * What a payout would arrive as through NEAR Intents (1Click): a dry quote, refreshed as the
 * amount changes. Nothing is reserved or sent.
 */
export function PayoutQuoteBox({ yocto, label = "The hire receives" }: { yocto: bigint; label?: string }) {
  const [asset, setAsset] = useState(PAYOUT_ASSETS[1].id);
  const [q, setQ] = useState<PayoutQuote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (yocto <= 0n) return;
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      payoutQuote(yocto, asset)
        .then((r) => live && (setQ(r), setErr(null)))
        .catch((e) => live && (setQ(null), setErr(e instanceof Error ? e.message : String(e))))
        .finally(() => live && setBusy(false));
    }, 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [yocto, asset]);

  return (
    <div className="intents" data-tour="intents">
      <div className="intents-head">
        <span className="tx-k">Paid out with NEAR Intents</span>
        <select value={asset} onChange={(e) => setAsset(e.target.value)} aria-label="Payout token">
          {PAYOUT_ASSETS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <div className="intents-line">
        <span>{label}</span>
        <b className="mono">{busy && !q ? "quoting…" : q ? `${q.amountOut} ${q.asset.label.split(" ")[0]}` : "—"}</b>
      </div>
      {q && (
        <div className="intents-note">
          about ${Number(q.amountOutUsd).toFixed(2)}, in ~{q.timeEstimateSec}s, through 1Click. A dry quote at mainnet prices: nothing is reserved or sent.
        </div>
      )}
      {err && <div className="intents-note">1Click: {err}</div>}
    </div>
  );
}
