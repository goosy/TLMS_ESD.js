import "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LAYOUT_SCOPE } from "../src/layouts.js";

const ROOT = join(import.meta.dirname, "..");
// the layout-types command of layout-data, run with this Node.js (pnpm gen:types)
const LAYOUT_TYPES = fileURLToPath(import.meta.resolve("layout-data/dev"));

test("src/layout_types.d.ts is up to date with layouts.yaml (run `pnpm gen:types`)", () => {
	// the same arguments as the gen:types script, which names the scope tlms
	const rendered = execFileSync(process.execPath, [LAYOUT_TYPES, "src/layouts.yaml", "--scope", LAYOUT_SCOPE], {
		cwd: ROOT,
		encoding: "utf8",
	});
	assert.equal(readFileSync(join(ROOT, "src/layout_types.d.ts"), "utf8"), rendered);
});
