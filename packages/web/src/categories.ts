/**
 * Kinds of work a client can ask for. The same list the orchestrator files on chain
 * (packages/orchestrator/src/categories.ts); kept here so the page needs no extra RPC call.
 */
export const CATEGORIES = [
  { id: "parsing", title: "Parsing text formats", description: "Turn strings in a strict format (CSV, durations) into data, rejecting anything malformed." },
  { id: "expressions", title: "Evaluating expressions", description: "Parse and evaluate small languages: arithmetic with precedence, unary operators, errors." },
  { id: "scheduling", title: "Dates and schedules", description: "Calendar arithmetic in UTC: cron expressions, next run times, edge dates." },
  { id: "versioning", title: "Versions and dependency ranges", description: "Version parsing and range matching with precedence and pre-release rules." },
];

/** League defaults for a brief's tryout round, as in packages/orchestrator/src/config.ts. */
export const TRYOUT_BOUNTY = 0.3;
export const TRYOUT_SUBSIDY = 0.5;
export const SCOUT_MIN_STAKE = 0.05;
export const IDENTITY_DEPOSIT = 0.02;
