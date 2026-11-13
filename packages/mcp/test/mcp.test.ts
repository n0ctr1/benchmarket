import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, TOOLS } from "../src/server.js";

test("speaks MCP: initialize, list tools, unknown method", async () => {
  const init = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })) as { result: { protocolVersion: string; capabilities: { tools: object } } };
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.ok(init.result.capabilities.tools);
  const list = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: Array<{ name: string; inputSchema: object }> } };
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    TOOLS.map((t) => t.name),
  );
  assert.ok(list.result.tools.every((t) => typeof t.inputSchema === "object"));
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const bad = (await handle({ jsonrpc: "2.0", id: 3, method: "nope" })) as { error: { code: number } };
  assert.equal(bad.error.code, -32601);
  const unknown = (await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } })) as { error: { code: number } };
  assert.equal(unknown.error.code, -32602);
});
