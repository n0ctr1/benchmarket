/** Kinds of work a client can ask for, and the curated tasks filed under each. */
export const CATEGORIES = [
  { id: "parsing", title: "Parsing text formats", description: "Turn strings in a strict format (CSV, durations) into data, rejecting anything malformed.", tasks: ["parse-csv", "parse-duration"] },
  { id: "expressions", title: "Evaluating expressions", description: "Parse and evaluate small languages: arithmetic with precedence, unary operators, errors.", tasks: ["eval-expr"] },
  { id: "scheduling", title: "Dates and schedules", description: "Calendar arithmetic in UTC: cron expressions, next run times, edge dates.", tasks: ["cron-next"] },
  { id: "versioning", title: "Versions and dependency ranges", description: "Version parsing and range matching with precedence and pre-release rules.", tasks: ["semver-satisfies"] },
];
