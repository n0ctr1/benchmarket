#!/usr/bin/env -S npx tsx
/**
 * Benchmarket over MCP (Model Context Protocol), read-only, on stdio. An agent or a hiring
 * assistant asks "who is the best agent for this kind of task?" and gets the answer straight
 * from the contract: ratings per skill, qualification checks, rounds, tasks by difficulty,
 * scouts by forecasting skill and passports. Nothing here signs or spends.
 *
 *   LEAGUE_ACCOUNT=benchmarket.testnet NEAR_RPC_URL=https://test.rpc.fastnear.com npx tsx packages/mcp/src/server.ts
 */
import { viewCall } from "@benchmarket/shared";

const CONTRACT = process.env.LEAGUE_ACCOUNT ?? "benchmarket.testnet";
const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";

type Json = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run: (a: Json) => Promise<unknown>;
}

const str = (d: string) => ({ type: "string", description: d });
const num = (d: string) => ({ type: "integer", description: d });
const view = (method: string, args: Json = {}) => viewCall(RPC, CONTRACT, method, args);
/** Ratings are stored in centi-points; agents read them in points. */
const points = (r: { rating?: number }) => ({ ...r, rating_points: (r.rating ?? 0) / 100 });

export const TOOLS: Tool[] = [
  {
    name: "get_leaderboard",
    description: "Agents ranked by rating for a skill (default code.js): rating, rounds, wins, attested answers, jobs paid and failed.",
    inputSchema: { type: "object", properties: { skill: str("Skill, e.g. code.js"), limit: num("At most this many rows") } },
    run: async (a) => ((await view("get_leaderboard", { skill: a.skill ?? "code.js", limit: a.limit ?? 50 })) as Json[]).map(points),
  },
  {
    name: "get_rating",
    description: "One agent's rating for a skill, with its record.",
    inputSchema: { type: "object", properties: { agent: str("Agent account, e.g. echo.benchmarket.testnet"), skill: str("Skill, default code.js") }, required: ["agent"] },
    run: async (a) => points((await view("get_rating", { agent: a.agent, skill: a.skill ?? "code.js" })) as Json),
  },
  {
    name: "is_qualified",
    description: "Whether an agent clears a hiring bar: a minimum rating (in points, e.g. 1500), and optionally a minimum number of rated rounds and of attested answers.",
    inputSchema: {
      type: "object",
      properties: { agent: str("Agent account"), min_rating: num("Minimum rating in points"), skill: str("Skill, default code.js"), min_rounds: num("Minimum rated rounds"), min_attested: num("Minimum attested answers") },
      required: ["agent", "min_rating"],
    },
    run: async (a) =>
      view("is_qualified", { agent: a.agent, skill: a.skill ?? "code.js", min_rating: Math.round(Number(a.min_rating) * 100), min_rounds: a.min_rounds ?? null, min_attested: a.min_attested ?? null }),
  },
  {
    name: "best_agent_for",
    description: "The highest-rated agents that clear a bar, best first: the shortlist a client would hire from.",
    inputSchema: { type: "object", properties: { min_rating: num("Minimum rating in points, default 0"), min_rounds: num("Minimum rated rounds, default 1"), limit: num("How many, default 3"), skill: str("Skill, default code.js") } },
    run: async (a) => {
      const rows = (await view("get_leaderboard", { skill: a.skill ?? "code.js", limit: 100 })) as Array<{ rating: number; rounds: number }>;
      return rows
        .filter((r) => r.rating >= Number(a.min_rating ?? 0) * 100 && r.rounds >= Number(a.min_rounds ?? 1))
        .slice(0, Number(a.limit ?? 3))
        .map(points);
    },
  },
  {
    name: "list_rounds",
    description: "Recent rounds, newest first: task, status, entrants with scores and market prices, winners.",
    inputSchema: { type: "object", properties: { limit: num("How many, default 10") } },
    run: async (a) => view("get_rounds", { limit: a.limit ?? 10 }),
  },
  {
    name: "get_round",
    description: "One round in full: entries, prices at the lock, scores, rating changes, proposal and dispute.",
    inputSchema: { type: "object", properties: { round_id: num("Round id") }, required: ["round_id"] },
    run: async (a) => view("get_round", { round_id: a.round_id }),
  },
  {
    name: "get_tasks",
    description: "Curated tasks with their difficulty rating, rounds and jobs played; retired tasks are flagged.",
    inputSchema: { type: "object", properties: {} },
    run: async () => view("get_tasks", { limit: 100 }),
  },
  {
    name: "get_scouts",
    description: "Scouts by forecasting skill (LMSR profit per unit of liquidity), with PnL and hits.",
    inputSchema: { type: "object", properties: { limit: num("How many, default 50") } },
    run: async (a) => view("get_scouts", { limit: a.limit ?? 50 }),
  },
  {
    name: "get_passport",
    description: "An agent's passport: number, face, motto, config hash and issue date.",
    inputSchema: { type: "object", properties: { agent: str("Agent account") }, required: ["agent"] },
    run: async (a) => view("get_identity", { agent: a.agent }),
  },
];

interface Request {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Json;
}

/** Handles one JSON-RPC message; returns the response, or null for a notification. */
export async function handle(msg: Request): Promise<Json | null> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  if (msg.id === undefined) return null;
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: (msg.params?.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "benchmarket", version: "0.1.0" },
        instructions: `Read-only access to the Benchmarket league contract ${CONTRACT}. Ratings are per skill; a rating of 1500 is the starting point.`,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `unknown tool ${String(msg.params?.name)}`);
      try {
        const out = await tool.run((msg.params?.arguments as Json) ?? {});
        return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return reply({ content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Newline-delimited JSON-RPC on stdin and stdout, as MCP's stdio transport specifies.
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Request;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
        continue;
      }
      const res = await handle(msg);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    }
  });
}
