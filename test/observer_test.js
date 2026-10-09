import { make_struct } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { TData } from "../src/typed_data/TData.js";

const ITEMS = [
	{ name: "a", type: "UInt", offset: 0, length: 16, init_value: 0 },
	{
		name: "flags", type: "Word", offset: 16, length: 16,
		is_combined: true, coupling: [
			{ name: "f0", type: "Bool", offset: 8, length: 1, init_value: false },
			{ name: "f8", type: "Bool", offset: 0, length: 1, init_value: false },
		],
	},
	{ name: "b", type: "UInt", offset: 32, length: 16, init_value: 0 },
];

const create = () => new TData(make_struct(ITEMS), "sample");

const record = (data) => {
	const events = [];
	data.on("change", (name, old_value, new_value) => events.push([name, old_value, new_value]));
	return events;
};

describe("Observer", () => {
	test("changes of one detection are reported in layout order", () => {
		const data = create();
		const events = record(data);
		data.buffer.writeUInt16BE(5, 4); // b
		data.buffer[2] = 0x01; // f8
		data.buffer[3] = 0x01; // f0
		data.buffer.writeUInt16BE(7, 0); // a
		data.detect();
		assert.deepEqual(events.map(([name]) => name), ["a", "flags", "f0", "f8", "b"]);
	});

	test("a value changed and restored before detection is not reported", () => {
		const data = create();
		const events = record(data);
		data.buffer.writeUInt16BE(9, 0);
		data.buffer.writeUInt16BE(0, 0);
		data.detect();
		assert.deepEqual(events, []);
	});

	test("a write by a change handler is reported after the current changes", () => {
		const data = create();
		const events = record(data);
		data.get("a").on("change", (_, value) => { data.b = value * 10; });
		data.buffer.writeUInt16BE(1, 0); // a
		data.buffer[3] = 0x01; // f0
		data.detect();
		assert.deepEqual(events, [["a", 0, 1], ["flags", 0, 1], ["f0", false, true], ["b", 0, 10]]);
		assert.equal(data.b, 10);
	});

	test("changes that never settle throw", () => {
		const data = create();
		data.get("a").on("change", () => { data.a += 1; });
		assert.throws(() => { data.a = 1; }, /do not settle/);
		// the observer recovers: the last unreported change is not lost
		data.get("a").removeAllListeners("change");
		const events = record(data);
		data.b = 3;
		assert.deepEqual(events, [["a", 16, 17], ["b", 0, 3]]);
	});

	test("previous() gives the value at the last scan snapshot", () => {
		const data = create();
		data.a = 4;
		assert.equal(data.observer.previous("a"), 0);
		data.observer.take_scan_snapshot();
		data.a = 5;
		assert.equal(data.observer.previous("a"), 4);
		assert.equal(data.a, 5);
	});
});
