/** Kinds of work a client can ask for, and the curated tasks filed under each. */
export const CATEGORIES = [
  { id: "parsing", title: "Parsing text formats", description: "Turn strings in a strict format (CSV, durations, URL queries) into data, rejecting anything malformed.", tasks: ["parse-csv", "parse-duration", "parse-query"] },
  { id: "expressions", title: "Evaluating expressions", description: "Parse and evaluate small languages: arithmetic with precedence, unary operators, errors.", tasks: ["eval-expr"] },
  { id: "scheduling", title: "Dates and schedules", description: "Calendar arithmetic in UTC: cron expressions, next run times, edge dates.", tasks: ["cron-next"] },
  { id: "versioning", title: "Versions and dependency ranges", description: "Version parsing and range matching with precedence and pre-release rules.", tasks: ["semver-satisfies"] },
  { id: "data", title: "Structured data", description: "Navigate and query JSON documents exactly as a standard defines, escapes and missing paths included.", tasks: ["json-pointer"] },
  { id: "state", title: "Caches and state machines", description: "Simulate stateful structures step by step: eviction order, recency, deletes, malformed operations.", tasks: ["lru-trace"] },
  { id: "text", title: "Text layout", description: "Lay text out under strict width and whitespace rules, long words and empty paragraphs included.", tasks: ["wrap-text"] },
  { id: "matching", title: "Pattern matching", description: "Match paths and names against glob patterns with classes, escapes and cross-segment wildcards.", tasks: ["glob-match", "regex-match"] },
  { id: "graphs", title: "Graphs and routing", description: "Cheapest routes in weighted graphs with exact, deterministic tie-breaking.", tasks: ["shortest-path"] },
  { id: "money", title: "Money and allocation", description: "Split amounts to the cent with exact integer arithmetic past the safe integer range.", tasks: ["split-bill", "decimal-div"] },
  { id: "encoding", title: "Binary encodings", description: "Decode bytes exactly as the standard does, malformed and truncated sequences included.", tasks: ["utf8-decode"] },
  { id: "querying", title: "Querying data (SQL)", description: "Answer questions about tables with one SQLite query: windows, ties, gaps and empty results included.", tasks: ["sql-country-leaders", "sql-running-balance", "sql-visits"] },
];
