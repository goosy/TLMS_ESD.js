// The TData / TTag programming interface, section by section of
// doc/spec-data-api.md.
import { make_struct } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test, { describe } from "node:test";
import { TData } from "../src/typed_data/TData.js";
import { TTag } from "../src/typed_data/TTag.js";
import { layout_of } from "../src/typed_data/layout.js";

// the word gives no init value: it is composed from its bits
const ITEMS = [
	{ name: "id", type: "UInt", offset: 0, length: 16, init_value: 7 },
	{
		name: "status", type: "Word", offset: 16, length: 16,
		coupling: [
			{ name: "run", type: "Bool", offset: 8, length: 1, init_value: true },
			{ name: "alarm", type: "Bool", offset: 0, length: 1 },
		],
	},
	{ name: "pressure", type: "Real", offset: 32, length: 32, init_value: 1.5 },
];
const LAYOUT = layout_of(make_struct(ITEMS, "SAMPLE"));

const record = (data) => {
	const events = [];
	data.on("change", (name, old_value, new_value) => events.push([name, old_value, new_value]));
	return events;
};

describe("2 TData", () => {
	test("2.1 a new data block holds the init values, without events", () => {
		const data = new TData(LAYOUT, "d");
		assert.equal(data.id, 7);
		assert.equal(data.run, true);
		assert.equal(data.alarm, false);
		assert.equal(data.status, 0x0001);
		assert.equal(data.pressure, 1.5);
		const events = record(data);
		data.detect();
		assert.deepEqual(events, []);
	});

	test("2.1 an unknown detection mode throws", () => {
		assert.throws(() => new TData(LAYOUT, "d", { detection: "later" }), /unknown detection mode later/);
	});

	test("2.2 properties", () => {
		const data = new TData(LAYOUT, "d");
		assert.equal(data.name, "d");
		assert.equal(data.layout, LAYOUT);
		assert.equal(data.size, 8);
		assert.equal(data.buffer.length, 8);
	});

	test("2.2 name is writable; layout, size and buffer are read-only, the buffer contents writable", () => {
		const data = new TData(LAYOUT, "d");
		data.name = "renamed";
		assert.equal(data.name, "renamed");
		const { buffer } = data;
		// ES modules run in strict mode: assigning a getter-only property throws
		assert.throws(() => { data.layout = null; }, TypeError);
		assert.throws(() => { data.size = 1; }, TypeError);
		assert.throws(() => { data.buffer = Buffer.alloc(8); }, TypeError);
		assert.equal(data.buffer, buffer);
		data.buffer.writeUInt16BE(9, 0);
		assert.equal(data.id, 9);
	});

	test("2.3 a write takes effect at once, for the data block and its TTag", () => {
		const data = new TData(LAYOUT, "d");
		data.pressure = 2.5;
		assert.equal(data.pressure, 2.5);
		assert.equal(data.get("pressure").value, 2.5);
	});

	test("2.3 a combined word and its bits follow each other", () => {
		const data = new TData(LAYOUT, "d");
		data.alarm = true;
		assert.equal(data.status, 0x0101);
		data.status = 0x0100;
		assert.equal(data.run, false);
		assert.equal(data.alarm, true);
	});

	test("2.3 an out-of-range integer throws RangeError and keeps the value; a Bool takes truthiness", () => {
		const data = new TData(LAYOUT, "d");
		assert.throws(() => { data.id = -1; }, RangeError);
		assert.equal(data.id, 7);
		data.alarm = 1;
		assert.equal(data.alarm, true);
	});

	test("2.4 get() returns the same TTag for a name, undefined for an unknown one", () => {
		const data = new TData(LAYOUT, "d");
		assert.ok(data.get("id") instanceof TTag);
		assert.equal(data.get("id"), data.get("id"));
		assert.equal(data.get("nope"), undefined);
	});

	test("2.6 detect() reports a direct write of the buffer", () => {
		const data = new TData(LAYOUT, "d");
		const events = record(data);
		data.buffer.writeUInt16BE(9, 0);
		assert.deepEqual(events, []);
		data.detect();
		assert.deepEqual(events, [["id", 7, 9]]);
	});
});

describe("3 TTag", () => {
	test("members describe the tag", () => {
		const tag = new TData(LAYOUT, "d").get("pressure");
		assert.equal(tag.name, "pressure");
		assert.equal(tag.type, "real");
		assert.equal(tag.length, 4);
	});

	test("value is readable and writable, the same as the data block property", () => {
		const data = new TData(LAYOUT, "d");
		const tag = data.get("id");
		const events = record(data);
		const tag_events = [];
		tag.on("change", (...args) => tag_events.push(args));
		tag.value = 12;
		assert.equal(tag.value, 12);
		assert.equal(data.id, 12);
		assert.deepEqual(events, [["id", 7, 12]]);
		assert.deepEqual(tag_events, [[7, 12]]);
		assert.throws(() => { tag.value = 70000; }, RangeError);
		assert.equal(tag.value, 12);
	});
});

describe("4.3 changes and events", () => {
	test("every source of change is reported: property, TTag, direct buffer write", () => {
		const data = new TData(LAYOUT, "d");
		const events = record(data);
		data.id = 1;
		data.get("id").value = 2;
		data.buffer.writeUInt16BE(3, 0);
		data.detect();
		assert.deepEqual(events, [["id", 7, 1], ["id", 1, 2], ["id", 2, 3]]);
	});

	test("events come after the new value is applied, only on a real change", () => {
		const data = new TData(LAYOUT, "d");
		const seen = [];
		data.on("change", (name) => seen.push([name, data[name]]));
		data.id = 7;
		data.pressure = Number.NaN;
		data.pressure = Number.NaN;
		assert.deepEqual(seen.map(([name]) => name), ["pressure"]);
		assert.ok(Number.isNaN(seen[0][1]));
	});

	test("a combined word and its changed bits each emit, in layout order, data block before TTag", () => {
		const data = new TData(LAYOUT, "d");
		const order = [];
		data.on("change", (name) => order.push(`data:${name}`));
		data.get("alarm").on("change", () => order.push("tag:alarm"));
		data.get("status").on("change", () => order.push("tag:status"));
		data.alarm = true;
		assert.deepEqual(order, ["data:status", "tag:status", "data:alarm", "tag:alarm"]);
	});

	test("a handler may write any tag; that change follows the current changes", () => {
		const data = new TData(LAYOUT, "d");
		const events = record(data);
		data.get("id").on("change", () => { data.alarm = true; });
		data.id = 8;
		assert.deepEqual(events, [["id", 7, 8], ["status", 1, 0x0101], ["alarm", false, true]]);
	});

	test("handlers triggering each other without end throw after 16 rounds; no change is lost", () => {
		const data = new TData(LAYOUT, "d");
		const ping = () => { data.id += 1; };
		data.get("id").on("change", ping);
		assert.throws(() => { data.id = 0; }, /do not settle after 16 rounds/);
		data.get("id").off("change", ping);
		const events = record(data);
		data.detect();
		assert.equal(events.length, 1);
		assert.equal(events[0][0], "id");
	});
});

describe("4.2 immediate mode", () => {
	test("the events of a write are emitted before the write returns", () => {
		const data = new TData(LAYOUT, "d");
		const events = record(data);
		data.pressure = 3;
		assert.deepEqual(events, [["pressure", 1.5, 3]]);
	});

	test("on_write is called after every write, once its events are emitted", () => {
		const calls = [];
		const data = new TData(LAYOUT, "d", { on_write: (d) => calls.push([d, d.pressure]) });
		data.on("change", (name) => calls.push(name));
		data.pressure = 3;
		data.pressure = 3; // unchanged: no event, but still a write
		assert.deepEqual(calls, ["pressure", [data, 3], [data, 3]]);
	});
});

describe("4.2 deferred mode", () => {
	const create = () => {
		const writes = [];
		const data = new TData(LAYOUT, "d", { detection: "deferred", on_write: (d) => writes.push(d) });
		return { data, writes, events: record(data) };
	};

	test("a write takes effect, calls on_write and emits nothing until detect()", () => {
		const { data, writes, events } = create();
		data.id = 9;
		data.get("pressure").value = 2;
		assert.equal(data.id, 9);
		assert.deepEqual(writes, [data, data]);
		assert.deepEqual(events, []);
		data.detect();
		assert.deepEqual(events, [["id", 7, 9], ["pressure", 1.5, 2]]);
	});

	test("writes between two detections are merged, from the value at the last detection", () => {
		const { data, events } = create();
		data.id = 1;
		data.id = 2;
		data.id = 3;
		data.detect();
		assert.deepEqual(events, [["id", 7, 3]]);
	});

	test("a value changed and restored before detection is not reported", () => {
		const { data, events } = create();
		data.run = false;
		data.run = true;
		data.detect();
		assert.deepEqual(events, []);
	});

	test("a write by a handler calls on_write and is reported by a later detection", () => {
		const { data, writes, events } = create();
		data.get("id").on("change", () => { data.alarm = true; });
		data.id = 8;
		data.detect();
		assert.equal(writes.length, 2);
		assert.deepEqual(events, [["id", 7, 8]]);
		data.detect();
		assert.deepEqual(events.slice(1), [["status", 1, 0x0101], ["alarm", false, true]]);
	});

	test("without on_write, writes are still allowed and detected later", () => {
		const data = new TData(LAYOUT, "d", { detection: "deferred" });
		const events = record(data);
		data.id = 5;
		assert.deepEqual(events, []);
		data.detect();
		assert.deepEqual(events, [["id", 7, 5]]);
	});
});

describe("5 errors", () => {
	test("a tag name colliding with a data block member throws at creation", () => {
		const struct = make_struct([{ name: "detect", type: "UInt", offset: 0, length: 16, init_value: 0 }], "BAD");
		assert.throws(() => new TData(struct, "d"), /collides with a TData member/);
	});
});
