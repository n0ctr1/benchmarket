import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const DATA_DIR = path.join(REPO_ROOT, ".data");

const envFile = path.join(REPO_ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing env ${name} (see .env.example)`);
}

export const NEAR = 10n ** 24n;

/** Parses a decimal NEAR amount ("0.25") into yoctoNEAR. */
export function near(amount: string | number): bigint {
  const [whole, frac = ""] = String(amount).split(".");
  return BigInt(whole || "0") * NEAR + BigInt((frac + "0".repeat(24)).slice(0, 24));
}

export function formatNear(yocto: bigint | string, digits = 3): string {
  const v = BigInt(yocto);
  const sign = v < 0n ? "-" : "";
  const a = v < 0n ? -v : v;
  const whole = a / NEAR;
  const frac = (a % NEAR).toString().padStart(24, "0").slice(0, digits);
  return `${sign}${whole}.${frac}`;
}

export const config = {
  get network() {
    return env("NEAR_NETWORK", "testnet");
  },
  get rpcUrl() {
    return env("NEAR_RPC_URL", "https://test.rpc.fastnear.com");
  },
  get leagueAccount() {
    return env("LEAGUE_ACCOUNT");
  },
  get leaguePrivateKey() {
    return process.env.LEAGUE_PRIVATE_KEY || undefined;
  },
  get verifierSecretKeys() {
    return env("VERIFIER_SECRET_KEYS").split(",").map((s) => s.trim()).filter(Boolean);
  },
  get verifierPublicKeys() {
    return env("VERIFIER_PUBLIC_KEYS").split(",").map((s) => s.trim()).filter(Boolean);
  },
  get verifierThreshold() {
    return Number(env("VERIFIER_THRESHOLD", "1"));
  },
  get verifierUrl() {
    return env("VERIFIER_URL", "http://localhost:8787");
  },
  get nearAiApiKey() {
    return process.env.NEAR_AI_API_KEY || undefined;
  },
  /** Every NEAR AI key in .env, in order: the next one takes over when one runs out of credit. */
  get nearAiApiKeys(): string[] {
    return [process.env.NEAR_AI_API_KEY, process.env.NEAR_AI_API_KEY2].filter((k): k is string => !!k);
  },
  get nearAiBaseUrl() {
    return env("NEAR_AI_BASE_URL", "https://cloud-api.near.ai/v1");
  },
  get bounty() {
    return near(env("BOUNTY_NEAR", "0.3"));
  },
  /** Market maker subsidy per round: its maximum loss. */
  get subsidy() {
    return near(env("SUBSIDY_NEAR", process.env.SEED_NEAR || "0.5"));
  },
  /** Arbiter keys decide disputes; in production they belong to other parties. */
  get arbiterSecretKeys() {
    return (process.env.ARBITER_SECRET_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  },
  get disputeWindowSeconds() {
    return Number(env("DISPUTE_WINDOW_SECONDS", "120"));
  },
  /** Stake a scout puts behind each nomination on a brief. */
  get scoutStake() {
    return near(env("SCOUT_STAKE_NEAR", "0.02"));
  },
  /** A brief's tryout round: a small bounty for its winner... */
  get tryoutBounty() {
    return near(env("TRYOUT_BOUNTY_NEAR", "0.02"));
  },
  /** ...and the tryout market's subsidy, its maximum loss; what the maker keeps goes back to the client. */
  get tryoutSubsidy() {
    return near(env("TRYOUT_SUBSIDY_NEAR", "0.05"));
  },
  get verifierStake() {
    return near(env("VERIFIER_STAKE_NEAR", "0.2"));
  },
  get builderStake() {
    return near(env("BUILDER_STAKE_NEAR", "0.1"));
  },
  get scoutBet() {
    return near(env("SCOUT_BET_NEAR", "0.2"));
  },
};
