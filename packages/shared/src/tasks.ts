import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Tagged } from "./hash.js";

export interface TestCase {
  args: unknown[];
  expected: unknown;
}

/** What competitors see. */
export interface TaskPublic {
  id: string;
  skill: string;
  function: string;
  title: string;
  statement: string;
  examples: TestCase[];
}

/** What only the verifier sees. */
export interface TaskWithTests extends TaskPublic {
  tests: TestCase[];
  /** sha256 of the raw tests.json, committed on chain in create_round. */
  testsHash: string;
  referencePath: string;
}

export const TASKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tasks");

export function listTaskIds(dir = TASKS_DIR): string[] {
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, "task.json")))
    .sort();
}

export function loadTask(id: string, dir = TASKS_DIR): TaskWithTests {
  const base = path.join(dir, id);
  const task = JSON.parse(fs.readFileSync(path.join(base, "task.json"), "utf8")) as TaskPublic;
  const rawTests = fs.readFileSync(path.join(base, "tests.json"), "utf8");
  return {
    ...task,
    tests: JSON.parse(rawTests) as TestCase[],
    testsHash: sha256Tagged(rawTests),
    referencePath: path.join(base, "reference.js"),
  };
}

export function publicView(task: TaskWithTests): TaskPublic {
  const { id, skill, function: fn, title, statement, examples } = task;
  return { id, skill, function: fn, title, statement, examples };
}
