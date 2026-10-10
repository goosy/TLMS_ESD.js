import { controller_layouts } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { node_parameters } from "../src/layouts.js";

// the rules of a valid layout are checked by layout-data when the layouts are registered;
// these are the layouts of the controller
describe("controller layouts", () => {
	const { LINE, SECTION, NODE, COMMAND, RECORD } = controller_layouts();

	for (const layout of [LINE, SECTION, NODE, COMMAND, RECORD]) {
		test(`${layout.name} is registered`, () => {
			assert.ok(layout.size > 0);
		});
	}

	test("NODE and COMMAND include the parameter block", () => {
		const first = node_parameters[0].name;
		assert.equal(NODE.items.find((it) => it.name === first).offset, 144);
		assert.equal(COMMAND.items.find((it) => it.name === first).offset, 160);
	});
});
