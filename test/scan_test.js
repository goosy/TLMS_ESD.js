import { create_fake_driver, register_test_layouts } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { describe } from "node:test";
import { Ldata } from "modbus-emulator";
import { Binding } from "../src/drivers/binding.js";
import { Scheduler } from "../src/scan.js";
import { derive, act, on_delay } from "../src/rules.js";

const PERIOD = 500;
const ITEMS = ["a", "b", "c"].map((name, i) => ({ name, type: "UInt", offset: i * 16, length: 16, init_value: 0 }));
const BOOLS = [
	...["flag", "out", "seen"].map((name, i) => ({ name, type: "Bool", offset: i, length: 1, init_value: false })),
	{ name: "pad", type: "Byte", offset: 8, length: 8, init_value: 0 },
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

register_test_layouts({ ITEMS, BOOLS, WORD });

/** Lets pending setImmediate callbacks run. */
const flush = async () => {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A scheduler with data blocks; add_data wires their writes to request_scan. */
function setup({ layout = "ITEMS", blocks = ["D"], on_error } = {}) {
	const errors = [];
	const scheduler = new Scheduler({ period: PERIOD, on_error: on_error ?? ((error, source) => errors.push([error, source])) });
	const data = blocks.map((name) => new Ldata(layout, name));
	for (const d of data) scheduler.add_data(d);
	return { scheduler, data, errors };
}

describe("Scheduler setup", () => {
	test("rules are checked and ordered by prepare(); nothing is added afterwards", () => {
		const { scheduler, data: [d] } = setup();
		scheduler.add_rule(derive({ name: "b", reads: [[d, "a"]], writes: [[d, "b"]], run: () => { } }));
		scheduler.add_rule(derive({ name: "a", writes: [[d, "a"]], run: () => { } }));
		assert.throws(() => scheduler.scan(false), /prepare\(\)/);
		assert.throws(() => scheduler.start(), /prepare\(\)/);
		scheduler.prepare();
		assert.deepEqual(scheduler.ordered_rules.map((rule) => rule.name), ["a", "b"]);
		assert.throws(() => scheduler.add_data(d), /prepared/);
		assert.throws(() => scheduler.add_rule(act({ name: "x", run: () => { } })), /prepared/);
	});

	test("prepare() throws every rule violation", () => {
		const { scheduler, data: [d] } = setup();
		scheduler.add_rule(act({ name: "x", reads: [[d, "nope"]], run: () => { } }));
		assert.throws(() => scheduler.prepare(), (error) => error.errors.length === 1);
	});

	test("an invalid period throws", () => {
		assert.throws(() => new Scheduler({ period: 0 }), /invalid scan period/);
	});
});

describe("scan phases (design 5.1)", () => {
	test("input loads fresh data, rules see it, changes are emitted at the write, output writes", async () => {
		const { scheduler, data: [d] } = setup();
		const driver = create_fake_driver(2);
		const binding = new Binding(d, driver);
		const input = binding.create_group("a");
		const output = binding.create_group("b");
		scheduler.add_binding(binding, input);
		const order = [];
		scheduler.add_rule(derive({
			name: "b from a",
			reads: [[d, "a"]],
			writes: [[d, "b"]],
			run: () => {
				order.push(`rule sees a=${d.a}`);
				d.b = d.a + 1;
				binding.request_write(output);
			},
		}));
		d.on("change", (name, _old, value) => order.push(`event ${name}=${value}`));
		scheduler.prepare();

		driver.remote.writeUInt16BE(41, 0);
		await binding.request_read();
		assert.equal(binding.fresh, true);
		scheduler.scan(false);
		assert.equal(binding.fresh, false);
		assert.deepEqual(order, ["event a=41", "rule sees a=41", "event b=42"]);
		await flush();
		assert.deepEqual(driver.writes.map(({ start, bytes }) => [start, bytes]), [[2, [0, 42]]]);
		// reads are started by periodic ticks only
		assert.equal(driver.reads.length, 1);
		scheduler.scan(true);
		await flush();
		assert.equal(driver.reads.length, 2);
	});

	test("a binding without an input group is only written: never read nor loaded", async () => {
		const { scheduler, data: [d] } = setup();
		const driver = create_fake_driver(2);
		const binding = new Binding(d, driver);
		const output = binding.create_group("b");
		scheduler.add_binding(binding);
		scheduler.add_rule(act({ name: "send", run: () => binding.request_write(output) }));
		scheduler.prepare();
		d.b = 7;
		scheduler.scan(true);
		await flush();
		assert.equal(driver.reads.length, 0);
		// the write of d.b also requests a scan, which writes again
		assert.ok(driver.writes.length > 0);
		for (const { start, bytes } of driver.writes) assert.deepEqual([start, bytes], [2, [0, 7]]);
	});
});

describe("scan requests (design 5.2)", () => {
	test("requests in one turn of the event loop make one triggered scan", async () => {
		const { scheduler, data: [d] } = setup();
		let runs = 0;
		scheduler.add_rule(act({ name: "count", reads: [[d, "a"]], run: () => { runs++; } }));
		scheduler.prepare();
		scheduler.request_scan();
		scheduler.request_scan();
		d.a = 1; // the write event requests a scan too
		assert.equal(runs, 0);
		await flush();
		assert.equal(runs, 1);
	});

	test("writes by rules do not request another scan", async () => {
		const { scheduler, data: [d] } = setup();
		let runs = 0;
		scheduler.add_rule(derive({
			name: "write b",
			writes: [[d, "b"]],
			run: () => {
				runs++;
				d.b = runs;
			},
		}));
		scheduler.prepare();
		scheduler.request_scan();
		await flush();
		await flush();
		assert.equal(runs, 1);
	});

	test("a write by a change handler is seen by the triggered scan", async () => {
		const { scheduler, data: [d] } = setup();
		const seen = [];
		scheduler.add_rule(act({ name: "see c", reads: [[d, "c"]], run: () => { seen.push(d.c); } }));
		d.on("change", (name, _old, value) => { if (name === "a") d.c = value * 10; });
		scheduler.prepare();
		d.a = 2; // its handler writes c at once; both writes request one scan
		await flush();
		assert.deepEqual(seen, [20]);
	});

	test("a periodic tick does a pending triggered scan", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const { scheduler, data: [d] } = setup();
		const ticks = [];
		scheduler.add_rule(act({
			name: "ticker",
			reads: [[d, "a"]],
			run: (ticker) => {
				ticker.start();
				ticks.push(ticker.count);
			},
		}));
		scheduler.prepare();
		scheduler.start();
		t.after(() => scheduler.stop());
		scheduler.request_scan();
		t.mock.timers.tick(PERIOD);
		await flush();
		// one scan only: the periodic one, which advanced nothing yet started
		assert.deepEqual(ticks, [0]);
		t.mock.timers.tick(PERIOD);
		assert.deepEqual(ticks, [0, 1]);
	});

	test("scan() called during a scan runs after it", async () => {
		const { scheduler, data: [d] } = setup();
		let runs = 0;
		scheduler.add_rule(act({ name: "nested", reads: [[d, "a"]], run: () => { if (runs++ === 0) scheduler.scan(false); } }));
		scheduler.prepare();
		scheduler.scan(false);
		assert.equal(runs, 1);
		await flush();
		assert.equal(runs, 2);
	});
});

describe("timing with tickers (design 6.3)", () => {
	function setup_delay() {
		const { scheduler, data: [d] } = setup({ layout: "BOOLS" });
		scheduler.add_rule(derive({
			name: "delayed out",
			reads: [[d, "flag"]],
			writes: [[d, "out"]],
			run: (ticker) => { d.out = on_delay(ticker, d.flag, 1000); },
		}));
		scheduler.prepare();
		return { scheduler, d };
	}

	test("a condition set between ticks outputs at tick floor(delay / period) + 1", () => {
		const { scheduler, d } = setup_delay();
		d.flag = true;
		scheduler.scan(false);
		for (let i = 1; i <= 2; i++) {
			scheduler.scan(true);
			assert.equal(d.out, false, `tick ${i}`);
		}
		scheduler.scan(true);
		assert.equal(d.out, true);
	});

	test("triggered scans do not advance the count", () => {
		const { scheduler, d } = setup_delay();
		d.flag = true;
		scheduler.scan(false);
		for (let i = 0; i < 10; i++) scheduler.scan(false);
		scheduler.scan(true);
		scheduler.scan(true);
		assert.equal(d.out, false);
	});

	test("a condition dropping in a triggered scan resets at once", () => {
		const { scheduler, d } = setup_delay();
		d.flag = true;
		for (let i = 0; i < 4; i++) scheduler.scan(true);
		assert.equal(d.out, true);
		d.flag = false;
		scheduler.scan(false);
		assert.equal(d.out, false);
		d.flag = true;
		scheduler.scan(false);
		scheduler.scan(true);
		assert.equal(d.out, false);
	});

	test("a ticker started in a tick scan counts from the next tick", () => {
		const { scheduler, d } = setup_delay();
		d.flag = true;
		scheduler.scan(true); // started here: count 0
		scheduler.scan(true); // 1
		scheduler.scan(true); // 2
		assert.equal(d.out, false);
		scheduler.scan(true); // 3
		assert.equal(d.out, true);
	});
});

describe("error isolation (design 5.4)", () => {
	test("a failing rule is reported and the following rules still run", () => {
		const { scheduler, data: [d], errors } = setup();
		let ran = false;
		const bad = act({ name: "bad", reads: [[d, "a"]], run: () => { throw new Error("rule failed"); } });
		scheduler.add_rule(bad);
		scheduler.add_rule(act({ name: "good", reads: [[d, "b"]], run: () => { ran = true; } }));
		scheduler.prepare();
		scheduler.scan(false);
		assert.equal(ran, true);
		assert.equal(errors.length, 1);
		assert.equal(errors[0][0].message, "rule failed");
		assert.equal(errors[0][1], bad);
		assert.equal(scheduler.phase, "idle");
	});

	test("a failing change handler is reported with its binding and the other bindings are still loaded", async () => {
		const { scheduler, data: [d1, d2], errors } = setup({ blocks: ["D1", "D2"] });
		const events = [];
		d1.on("change", () => { throw new Error("handler failed"); });
		d2.on("change", (name) => events.push(name));
		const bindings = [d1, d2].map((d) => {
			const driver = create_fake_driver(2);
			driver.remote.writeUInt16BE(1, 0);
			const binding = new Binding(d, driver);
			scheduler.add_binding(binding, binding.create_group("a"));
			return binding;
		});
		scheduler.prepare();
		await Promise.all(bindings.map((binding) => binding.request_read()));
		scheduler.scan(false);
		assert.deepEqual(events, ["a"]);
		assert.equal(errors.length, 1);
		assert.equal(errors[0][1], bindings[0]);
		assert.equal(d1.a, 1);
		assert.equal(bindings[0].fresh, false);
	});

	test("a failing write is reported with its binding", async () => {
		const { scheduler, data: [d], errors } = setup();
		const driver = create_fake_driver(2);
		driver.write = async () => { throw new Error("write failed"); };
		const binding = new Binding(d, driver);
		scheduler.add_binding(binding, binding.create_group("a"));
		scheduler.prepare();
		binding.request_write(binding.create_group("b"));
		scheduler.scan(false);
		await flush();
		assert.equal(errors.length, 1);
		assert.equal(errors[0][0].message, "write failed");
		assert.equal(errors[0][1], binding);
	});
});

describe("previous values and edges (design 5.1)", () => {
	test("a tag: the value at the end of the last scan", () => {
		const { scheduler, data: [d] } = setup({ layout: "BOOLS" });
		const seen = [];
		scheduler.add_rule(act({ name: "edge", reads: [[d, "flag"]], run: () => { seen.push(scheduler.rose(d, "flag")); } }));
		scheduler.prepare();
		d.flag = true;
		scheduler.scan(false);
		scheduler.scan(false);
		d.flag = false;
		assert.equal(scheduler.fell(d, "flag"), true);
		assert.deepEqual(seen, [true, false]);
	});

	test("a binding state", () => {
		const { scheduler, data: [d] } = setup();
		const driver = Object.assign(new EventEmitter(), create_fake_driver(2));
		const binding = new Binding(d, driver);
		scheduler.add_binding(binding, binding.create_group("a"));
		const seen = [];
		scheduler.add_rule(act({ name: "link", reads: [[binding, "connected"]], run: () => { seen.push(scheduler.fell(binding, "connected")); } }));
		scheduler.prepare();
		scheduler.scan(false);
		driver.emit("connfailed", "lost");
		scheduler.scan(false);
		scheduler.scan(false);
		assert.deepEqual(seen, [false, true, false]);
		assert.throws(() => scheduler.previous(binding, "write_done"), /no previous value/);
	});

	test("a registered variable; an unregistered one throws", () => {
		const { scheduler } = setup();
		const section = { name: "S1", trigger: false, other: 0 };
		scheduler.add_var(section, "trigger");
		const seen = [];
		scheduler.add_rule(act({ name: "var edge", reads: [[section, "trigger"]], run: () => { seen.push(scheduler.rose(section, "trigger")); } }));
		scheduler.prepare();
		section.trigger = true;
		scheduler.scan(false);
		scheduler.scan(false);
		assert.deepEqual(seen, [true, false]);
		assert.equal(scheduler.changed(section, "trigger"), false);
		assert.throws(() => scheduler.previous(section, "other"), /not a registered variable/);
		assert.throws(() => scheduler.add_var(null, "x"), /prepared|must be an object/);
	});
});

describe("breaking a cycle by reads_previous (design 6.4)", () => {
	test("the key read by reads_previous lags one scan behind", () => {
		const { scheduler, data: [d] } = setup();
		// a counts the scans; b follows a; a reads the previous b to close the loop
		scheduler.add_rule(derive({
			name: "a",
			reads_previous: [[d, "b"]],
			writes: [[d, "a"]],
			run: () => { d.a = scheduler.previous(d, "b") + 1; },
		}));
		scheduler.add_rule(derive({ name: "b", reads: [[d, "a"]], writes: [[d, "b"]], run: () => { d.b = d.a; } }));
		scheduler.prepare();
		const seen = [];
		for (let i = 0; i < 3; i++) {
			scheduler.scan(false);
			seen.push([d.a, d.b]);
		}
		assert.deepEqual(seen, [[1, 1], [2, 2], [3, 3]]);
	});
});

describe("dependency tracing (design 6.5)", () => {
	test("a read of a combined word is declared by the word or all its bits", (t) => {
		const { scheduler, data: [d] } = setup({ layout: "WORD" });
		scheduler.add_rule(act({ name: "by word", reads: [[d, "word"]], writes: [[d, "n"]], run: () => { d.n = d.word + d.b0; } }));
		scheduler.add_rule(act({ name: "by bits", reads: [[d, "b0"], [d, "b1"]], run: () => d.word }));
		scheduler.add_rule(act({ name: "one bit", reads: [[d, "b0"]], run: () => d.word }));
		scheduler.prepare();
		const undeclared = scheduler.trace_dependencies();
		t.after(() => scheduler.untrace_dependencies());
		scheduler.scan(false);
		assert.deepEqual(undeclared, ["one bit: D.word read"]);
	});

	test("a direct read of a tag declared only in reads_previous is reported", (t) => {
		const { scheduler, data: [d] } = setup();
		scheduler.add_rule(derive({
			name: "mistaken",
			reads_previous: [[d, "a"]],
			writes: [[d, "b"]],
			run: () => { d.b = d.a; },
		}));
		scheduler.add_rule(derive({
			name: "right",
			reads_previous: [[d, "a"]],
			writes: [[d, "c"]],
			run: () => { d.c = scheduler.previous(d, "a"); },
		}));
		scheduler.prepare();
		const undeclared = scheduler.trace_dependencies();
		t.after(() => scheduler.untrace_dependencies());
		scheduler.scan(false);
		assert.deepEqual(undeclared, ["mistaken: D.a read"]);
	});

	test("tags accessed by a rule without being declared are reported", (t) => {
		const { scheduler, data: [d] } = setup();
		scheduler.add_rule(derive({ name: "honest", reads: [[d, "a"]], writes: [[d, "b"]], run: () => { d.b = d.a; } }));
		scheduler.add_rule(act({ name: "sneaky", reads: [[d, "b"]], run: () => { d.c = d.a + d.b; } }));
		scheduler.prepare();
		const undeclared = scheduler.trace_dependencies();
		t.after(() => scheduler.untrace_dependencies());
		scheduler.scan(false);
		scheduler.scan(false);
		assert.deepEqual(undeclared, ["sneaky: D.a read", "sneaky: D.c write"]);
		scheduler.untrace_dependencies();
		d.c = 0;
		assert.equal(undeclared.length, 2);
	});
});
