import { create_fake_driver, register_test_layouts } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { Ldata } from "modbus-emulator";
import { Binding } from "../src/drivers/binding.js";
import { Ticker, on_delay, off_delay, derive, act, order_rules, component_bits } from "../src/rules.js";

const uint_items = (tags) => tags.map((tag, i) => ({ name: tag, type: "UInt", offset: i * 16, length: 16, init_value: 0 }));
// register_layout succeeds once per process: the tag sets of the blocks are registered together
const TAG_SETS = [
	["a"],
	["a", "b"],
	["a", "b", "c"],
	["pump_run"],
	["pump_run", "flow_alarm_F", "pre_stop_notice"],
	["pump_run", "pre_stop_notice"],
];
const WORD = [
	{
		name: "word", type: "Word", offset: 0, length: 16, is_combined: true,
		coupling: [
			{ name: "b0", type: "Bool", offset: 8, length: 1, init_value: false },
			{ name: "b1", type: "Bool", offset: 9, length: 1, init_value: false },
		],
	},
	{ name: "n", type: "UInt", offset: 16, length: 16, init_value: 0 },
];
register_test_layouts({
	WORD,
	...Object.fromEntries(TAG_SETS.map((tags) => [tags.join("_"), uint_items(tags)])),
});

const block = (name, ...tags) => new Ldata(tags.join("_"), name);

const noop = () => { };
const names_of = (rules) => rules.map((rule) => rule.name);
const no_vars = () => false;

/** Asserts that ordering throws, every expected fragment found in some error. */
function assert_errors(rules, is_var, ...fragments) {
	let errors = null;
	try {
		order_rules(rules, is_var);
	} catch (error) {
		errors = error.errors;
	}
	assert.ok(errors, "the rules were accepted");
	for (const fragment of fragments) {
		assert.ok(errors.some((e) => e.includes(fragment)), `"${fragment}" not in:\n${errors.join("\n")}`);
	}
	return errors;
}

describe("Ticker", () => {
	test("counts from 0 when started; start() is a no-op while running", () => {
		const running = new Set();
		const ticker = new Ticker(running, 500);
		assert.equal(ticker.running, false);
		ticker.start();
		assert.ok(running.has(ticker));
		ticker.count = 3;
		ticker.start();
		assert.equal(ticker.count, 3);
		assert.equal(ticker.elapsed, 1500);
	});

	test("stop() clears and leaves the running set; restart() counts again from 0", () => {
		const running = new Set();
		const ticker = new Ticker(running, 500);
		ticker.start();
		ticker.count = 2;
		ticker.restart();
		assert.equal(ticker.count, 0);
		assert.ok(running.has(ticker));
		ticker.stop();
		assert.equal(ticker.running, false);
		assert.equal(ticker.count, 0);
		assert.ok(!running.has(ticker));
	});

	test("on_delay starts while the condition holds and stops when it drops", () => {
		const ticker = new Ticker(new Set(), 500);
		assert.equal(on_delay(ticker, true, 1000), false);
		assert.equal(ticker.running, true);
		ticker.count = 2;
		assert.equal(on_delay(ticker, true, 1000), false);
		ticker.count = 3;
		assert.equal(on_delay(ticker, true, 1000), true);
		assert.equal(on_delay(ticker, false, 1000), false);
		assert.equal(ticker.running, false);
	});

	test("off_delay holds while the condition holds and for the delay after it drops", () => {
		const ticker = new Ticker(new Set(), 500);
		assert.equal(off_delay(ticker, true, 1000), true);
		assert.equal(ticker.running, false);
		assert.equal(off_delay(ticker, false, 1000), true);
		assert.equal(ticker.running, true);
		ticker.count = 2;
		assert.equal(off_delay(ticker, false, 1000), true);
		ticker.count = 3;
		assert.equal(off_delay(ticker, false, 1000), false);
		// the condition back: true at once, counting stopped
		assert.equal(off_delay(ticker, true, 1000), true);
		assert.equal(ticker.running, false);
	});
});

describe("rule declarations", () => {
	test("derive and act build frozen rules of their kind", () => {
		const data = block("D", "a");
		const rule = derive({ name: "r", reads: [[data, "a"]], writes: [], run: noop });
		assert.equal(rule.kind, "derive");
		assert.equal(act({ name: "s", run: noop }).kind, "act");
		assert.ok(Object.isFrozen(rule));
	});

	test("a rule needs a run function and [owner, name] keys", () => {
		assert.throws(() => derive({ name: "r" }), /run must be a function/);
		assert.throws(() => act({ name: "r", reads: ["a"], run: noop }), /reads must be a list of \[owner, name\] keys/);
	});
});

describe("rule order", () => {
	test("a writer runs before its readers, whatever the declaration order", () => {
		const d = block("D", "a", "b", "c");
		const rules = [
			derive({ name: "c from b", reads: [[d, "b"]], writes: [[d, "c"]], run: noop }),
			derive({ name: "b from a", reads: [[d, "a"]], writes: [[d, "b"]], run: noop }),
			derive({ name: "a", writes: [[d, "a"]], run: noop }),
		];
		assert.deepEqual(names_of(order_rules(rules, no_vars)), ["a", "b from a", "c from b"]);
	});

	test("independent rules keep the declaration order", () => {
		const d = block("D", "a", "b", "c");
		const rules = ["x", "y", "z"].map((name, i) => derive({ name, writes: [[d, ["a", "b", "c"][i]]], run: noop }));
		assert.deepEqual(names_of(order_rules(rules, no_vars)), ["x", "y", "z"]);
	});

	test("a read of a key the rule also writes is no dependency", () => {
		const d = block("D", "a", "b");
		const line = { name: "line", autoStopCmd: false };
		const rules = [
			act({ name: "s1", reads: [[line, "autoStopCmd"]], writes: [[line, "autoStopCmd"], [d, "a"]], run: noop }),
			act({ name: "s2", reads: [[line, "autoStopCmd"]], writes: [[line, "autoStopCmd"], [d, "b"]], run: noop }),
		];
		const is_var = (owner, name) => owner === line && name === "autoStopCmd";
		assert.deepEqual(names_of(order_rules(rules, is_var)), ["s1", "s2"]);
	});

	test("several writers of a key keep their declaration order, all before its readers", () => {
		const d = block("D", "a", "b");
		const rules = [
			act({ name: "reader", reads: [[d, "a"]], writes: [[d, "b"]], run: noop }),
			act({ name: "writer 2", writes: [[d, "a"]], run: noop }),
			act({ name: "writer 1", writes: [[d, "a"]], run: noop }),
		];
		assert.deepEqual(names_of(order_rules(rules, no_vars)), ["writer 2", "writer 1", "reader"]);
	});

	test("dependencies across levels are ordered by key, not by level (design 6.4)", () => {
		const node = block("node", "pump_run");
		const section = block("section", "pump_run", "flow_alarm_F", "pre_stop_notice");
		const line = block("line", "pump_run", "pre_stop_notice");
		// declared in level order: sections before the line
		const rules = [
			derive({ name: "section pump_run", reads: [[node, "pump_run"]], writes: [[section, "pump_run"]], run: noop }),
			derive({
				name: "section pre_stop_notice",
				reads: [[section, "flow_alarm_F"], [line, "pump_run"]],
				writes: [[section, "pre_stop_notice"]],
				run: noop,
			}),
			derive({ name: "line pump_run", reads: [[section, "pump_run"]], writes: [[line, "pump_run"]], run: noop }),
			derive({ name: "line pre_stop_notice", reads: [[section, "pre_stop_notice"]], writes: [[line, "pre_stop_notice"]], run: noop }),
		];
		assert.deepEqual(names_of(order_rules(rules, no_vars)), [
			"section pump_run", "line pump_run", "section pre_stop_notice", "line pre_stop_notice",
		]);
	});
});

/** A block with a combined word "word" of the bits b0, b1, and a UInt "n". */
const word_block = (name) => new Ldata("WORD", name);

describe("combined words (design 6.1)", () => {
	test("the component bits of a combined word; none for other tags", () => {
		const d = word_block("W");
		assert.deepEqual(component_bits(d.layout, "word"), ["b0", "b1"]);
		assert.deepEqual(component_bits(d.layout, "b0"), []);
		assert.deepEqual(component_bits(d.layout, "n"), []);
	});

	test("a read of a combined word runs after the writers of each bit", () => {
		const d = word_block("W");
		const rules = [
			act({ name: "reader", reads: [[d, "word"]], writes: [[d, "n"]], run: noop }),
			act({ name: "writer b0", writes: [[d, "b0"]], run: noop }),
			act({ name: "writer b1", writes: [[d, "b1"]], run: noop }),
		];
		assert.deepEqual(names_of(order_rules(rules, no_vars)), ["writer b0", "writer b1", "reader"]);
	});

	test("writers of different bits have no dependency on each other", () => {
		const d = word_block("W");
		const rules = [
			act({ name: "writer b1", reads: [[d, "b0"]], writes: [[d, "b1"]], run: noop }),
			act({ name: "writer b0", reads: [[d, "b1"]], writes: [[d, "b0"]], run: noop }),
		];
		// each reads the other bit: a cycle by bits, not through the word
		assert_errors(rules, no_vars, "dependency cycle");
		const independent = [
			act({ name: "writer b1", writes: [[d, "b1"]], run: noop }),
			act({ name: "writer b0", writes: [[d, "b0"]], run: noop }),
		];
		assert.deepEqual(names_of(order_rules(independent, no_vars)), ["writer b1", "writer b0"]);
	});

	test("a combined word is not written", () => {
		const d = word_block("W");
		assert_errors([act({ name: "r", writes: [[d, "word"]], run: noop })], no_vars,
			"rule r: W.word: a combined word is not written, write its bits");
	});
});

describe("rule checks (design 6.4)", () => {
	test("a dependency cycle names its rules and keys", () => {
		const d = block("D", "a", "b", "c");
		const rules = [
			derive({ name: "free", writes: [[d, "c"]], run: noop }),
			derive({ name: "a from b", reads: [[d, "b"]], writes: [[d, "a"]], run: noop }),
			derive({ name: "b from a", reads: [[d, "a"]], writes: [[d, "b"]], run: noop }),
		];
		const [error] = assert_errors(rules, no_vars, "dependency cycle");
		assert.ok(error.includes("a from b -(D.a)-> b from a") || error.includes("b from a -(D.b)-> a from b"), error);
		assert.ok(!error.includes("free"), error);
	});

	test("a key written by a derive rule and another rule", () => {
		const d = block("D", "a");
		assert_errors([
			derive({ name: "d", writes: [[d, "a"]], run: noop }),
			act({ name: "e", writes: [[d, "a"]], run: noop }),
		], no_vars, "D.a: written by a derive rule and other rules (d, e)");
	});

	test("a binding state is read-only; unknown tags and states are reported", () => {
		const d = block("D", "a");
		const binding = new Binding(d, create_fake_driver());
		assert_errors([
			act({ name: "w", writes: [[binding, "connected"]], run: noop }),
			act({ name: "r", reads: [[binding, "online"], [d, "nope"]], run: noop }),
		], no_vars,
		"rule w: D binding.connected: a binding state is read-only",
		"rule r: D binding.online: no such binding state",
		"rule r: D.nope: no such tag");
	});

	test("variables must be registered properties of objects", () => {
		const section = { name: "S1", trigger: false };
		assert_errors([
			act({ name: "v", reads: [[section, "trigger"]], run: noop }),
			act({ name: "bare", reads: [[null, "x"]], run: noop }),
		], no_vars,
		"rule v: S1.trigger: variable not registered with add_var",
		"rule bare: x: a variable must be a property of an object");
		assert.doesNotThrow(() => order_rules(
			[act({ name: "v", reads: [[section, "trigger"]], run: noop })],
			(owner, name) => owner === section && name === "trigger",
		));
	});

	test("a cycle is reported with a hint to break it by reads_previous", () => {
		const d = block("D", "a", "b");
		const errors = assert_errors([
			derive({ name: "a from b", reads: [[d, "b"]], writes: [[d, "a"]], run: noop }),
			derive({ name: "b from a", reads: [[d, "a"]], writes: [[d, "b"]], run: noop }),
		], no_vars, "dependency cycle", "reads_previous");
		assert.equal(errors.length, 1);
	});

	test("reads_previous breaks a cycle: that read makes no dependency", () => {
		const d = block("D", "a", "b");
		const rules = [
			derive({ name: "b from a", reads: [[d, "a"]], writes: [[d, "b"]], run: noop }),
			derive({ name: "a from previous b", reads_previous: [[d, "b"]], writes: [[d, "a"]], run: noop }),
		];
		// a writer runs before its reader; the previous-value read imposes nothing
		assert.deepEqual(names_of(order_rules(rules, no_vars)), ["a from previous b", "b from a"]);
	});

	test("reads_previous keys must have a previous value", () => {
		const d = block("D", "a");
		const binding = new Binding(d, create_fake_driver());
		const section = { name: "S1", x: 0 };
		assert_errors([
			act({ name: "p", reads_previous: [[binding, "write_done"], [binding, "online"], [d, "nope"], [section, "x"]], run: noop }),
		], no_vars,
		"rule p: D binding.write_done: this binding state has no previous value",
		"rule p: D binding.online: no such binding state",
		"rule p: D.nope: no such tag",
		"rule p: S1.x: variable not registered with add_var");
		assert.doesNotThrow(() => order_rules(
			[act({ name: "p", reads_previous: [[binding, "connected"], [d, "a"], [section, "x"]], run: noop })],
			(owner, name) => owner === section && name === "x",
		));
	});

	test("rules need a unique name; every violation is reported at once", () => {
		const d = block("D", "a");
		const errors = assert_errors([
			act({ name: "", run: noop }),
			act({ name: "same", run: noop }),
			act({ name: "same", reads: [[d, "nope"]], run: noop }),
		], no_vars, "rule #0: no name", "rule same: duplicated name", "no such tag");
		assert.equal(errors.length, 3);
	});
});
