import "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { controller_types, types_file } from "../scripts/gen_types.js";

test("src/layout_types.d.ts is up to date with layouts.yaml (run `pnpm gen:types`)", async () => {
	assert.equal(readFileSync(types_file, "utf8"), await controller_types());
});
