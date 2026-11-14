/**
 * NEAR Intents through the 1Click API: what a league payout (a job budget, a scout reward)
 * would arrive as in another token on another chain. Dry quotes only: no deposit address is
 * reserved and nothing moves. 1Click runs on mainnet, so the quote prices the same amount of
 * NEAR there; on testnet it shows what the hire would receive once the league runs on mainnet.
 */
export const ONECLICK = "https://1click.chaindefuser.com/v0";

export interface PayoutAsset {
  id: string;
  label: string;
  assetId: string;
  decimals: number;
  /** A well-formed address on that chain for a quote without the hire's own. */
  sample: string;
}

export const PAYOUT_ASSETS: PayoutAsset[] = [
  { id: "usdc-near", label: "USDC on NEAR", assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6, sample: "intents.near" },
  { id: "usdc-base", label: "USDC on Base", assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6, sample: "0x1111111111111111111111111111111111111111" },
  { id: "usdc-arb", label: "USDC on Arbitrum", assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6, sample: "0x1111111111111111111111111111111111111111" },
  { id: "eth", label: "ETH on Ethereum", assetId: "nep141:eth.omft.near", decimals: 18, sample: "0x1111111111111111111111111111111111111111" },
];

const WNEAR = "nep141:wrap.near";

export interface PayoutQuote {
  asset: PayoutAsset;
  amountIn: string;
  amountOut: string;
  amountOutUsd: string;
  timeEstimateSec: number;
}

/** A dry 1Click quote for `yocto` NEAR paid out as `assetId` to `recipient` (or a sample). */
export async function payoutQuote(yocto: bigint, assetId: string, recipient?: string): Promise<PayoutQuote> {
  const asset = PAYOUT_ASSETS.find((a) => a.id === assetId || a.assetId === assetId);
  if (!asset) throw new Error(`unknown payout asset ${assetId}`);
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: WNEAR,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: asset.assetId,
    amount: yocto.toString(),
    refundTo: "intents.near",
    refundType: "ORIGIN_CHAIN",
    recipient: recipient || asset.sample,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const res = await fetch(`${ONECLICK}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json()) as { quote?: { amountInFormatted: string; amountOutFormatted: string; amountOutUsd: string; timeEstimate: number }; message?: string };
  if (!res.ok || !j.quote) throw new Error(`1Click: ${j.message ?? res.status}`);
  return { asset, amountIn: j.quote.amountInFormatted, amountOut: j.quote.amountOutFormatted, amountOutUsd: j.quote.amountOutUsd, timeEstimateSec: j.quote.timeEstimate };
}
