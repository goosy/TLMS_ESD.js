import { make_struct } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { LINE, SECTION, NODE, COMMAND, RECORD } from "../src/layouts.js";
import { TData } from "../src/typed_data/TData.js";

const is_arr_equal = (arr1, arr2) => {
	return arr1.length === arr2.length
		&& arr1.every((item, index) => item === arr2[index]);
};

const commands_list = [
	"stop_pumps", "cancel_stop",
	"horn", "reset_horn",
	"enable_pressure_SD", "disable_pressure_SD",
	"read_paras", "write_paras",
	"enable_pressure_alarm", "disable_pressure_alarm",
	"enable", "disable",
	"reset_CPU",
	"reset_conn", "reserve",
	"executing",
];

const node_status = [
	"comm_OK", "work_OK",
	"pump_run", "pump_change_F",
	"pump_run_1", "pump_run_2", "pump_run_3", "pump_run_4",
	"pressure_enabled", "temperature_enabled", "pressure_SD_F",
	"delay_protect",
	"pressure_AH_F", "pressure_WH_F",
	"pressure_WL_F", "pressure_AL_F",
];

test("NODE", () => {
	assert.strictEqual(NODE.length, 1168);
	assert.ok(is_arr_equal(NODE.items[1].coupling, node_status));
	assert.strictEqual(NODE.items[17].offset, 23);
	assert.ok(is_arr_equal(NODE.items[21].coupling, commands_list));
	assert.strictEqual(NODE.items[37].offset, 135);
	assert.strictEqual(NODE.items[38 + 35].offset, 144 + 992);
});

test("COMMAND", () => {
	assert.strictEqual(COMMAND.length, 1184);
	assert.ok(is_arr_equal(COMMAND.items[6].coupling, commands_list));
	assert.strictEqual(COMMAND.items[22].offset, 151);
	assert.strictEqual(COMMAND.items[23 + 35].offset, 160 + 992);
});

// "status" bit order: coupling offset 8 is word bit 0, offset 0 is word bit 8.
const SAMPLE_ITEMS = [
	{ name: "id", type: "UInt", offset: 0, length: 16, init_value: 7 },
	{
		name: "status", type: "Word", offset: 16, length: 16, init_value: 0x0101,
		is_combined: true, coupling: [
			{ name: "bit_0", type: "Bool", offset: 8, length: 1, init_value: true },
			{ name: "bit_1", type: "Bool", offset: 9, length: 1, init_value: false },
			{ name: "bit_8", type: "Bool", offset: 0, length: 1, init_value: true },
		],
	},
	{ name: "value", type: "Real", offset: 32, length: 32, init_value: 1.5 },
	{ name: "count", type: "DInt", offset: 64, length: 32, init_value: -1 },
];

const create_sample = () => new TData(make_struct(SAMPLE_ITEMS), "sample");

describe("TData layout", () => {
	test("buffer size is the struct bit length / 8", () => {
		const data = create_sample();
		assert.equal(data.size, 12);
		assert.equal(data.buffer.length, 12);
	});

	test("buffer holds init values in big-endian order", () => {
		const data = create_sample();
		assert.deepEqual([...data.buffer], [
			0x00, 0x07,
			0x01, 0x01,
			0x3f, 0xc0, 0x00, 0x00,
			0xff, 0xff, 0xff, 0xff,
		]);
	});

	test("tag accessors are defined once on the prototype of the compiled class", () => {
		const struct = make_struct(SAMPLE_ITEMS);
		const data = new TData(struct, "a");
		const other = new TData(struct, "b");
		const proto = Object.getPrototypeOf(data);
		assert.equal(Object.getPrototypeOf(other), proto);
		assert.ok(data instanceof TData);
		for (const name of ["id", "status", "bit_0", "bit_1", "bit_8", "value", "count"]) {
			assert.equal(Object.hasOwn(data, name), false, name);
			const desc = Object.getOwnPropertyDescriptor(proto, name);
			assert.ok(desc?.get && desc.set, name);
			assert.equal(desc.enumerable, true);
			assert.equal(desc.configurable, false);
		}
		assert.equal(data.layout, proto.constructor.layout);
	});

	test("instances of one struct share the class, buffers stay separate", () => {
		const data = new TData(NODE, "a");
		const other = new TData(NODE, "b");
		assert.equal(data.constructor, other.constructor);
		data.pressure = 1.5;
		assert.equal(other.pressure, 0);
	});

	test("get() returns the TTag, undefined for unknown names", () => {
		const data = create_sample();
		assert.equal(data.get("count").value, -1);
		assert.equal(data.get("count").name, "count");
		assert.equal(data.get("nope"), undefined);
	});

	test("tag name colliding with a TData member throws", () => {
		const items = [{ name: "get", type: "UInt", offset: 0, length: 16, init_value: 0 }];
		assert.throws(() => new TData(make_struct(items), "bad"), /collides with a TData member/);
	});

	test("tag name colliding with an instance field is rejected", () => {
		const items = [{ name: "name", type: "UInt", offset: 0, length: 16, init_value: 0 }];
		assert.throws(() => new TData(make_struct(items), "bad"), /collides with a TData member/);
	});
});

describe("TData change event", () => {
	test("property write emits (name, old, new) after the value is applied", () => {
		const data = create_sample();
		const events = [];
		data.on("change", (name, old_value, new_value) => {
			events.push([name, old_value, new_value, data[name]]);
		});
		data.count = 5;
		data.count = 5;
		assert.deepEqual(events, [["count", -1, 5, 5]]);
	});

	test("detect reports direct buffer writes (server path)", () => {
		const data = create_sample();
		const events = [];
		data.on("change", (name, old_value, new_value) => events.push([name, old_value, new_value]));
		data.buffer.writeUInt16BE(0x0002, 2);
		data.buffer.writeUInt16BE(9, 0);
		data.detect();
		assert.deepEqual(events.sort(), [
			["bit_0", true, false],
			["bit_1", false, true],
			["bit_8", true, false],
			["id", 7, 9],
			["status", 0x0101, 0x0002],
		]);
	});

	test("the data block event comes before the tag event", () => {
		const data = create_sample();
		const order = [];
		data.get("id").on("change", () => order.push("tag"));
		data.on("change", () => order.push("data"));
		data.id = 1;
		assert.deepEqual(order, ["data", "tag"]);
	});
});

describe("TData combined word", () => {
	test("writing the word updates the bits", () => {
		const data = create_sample();
		const events = [];
		data.on("change", (name) => events.push(name));
		data.status = 0x0002;
		assert.equal(data.bit_0, false);
		assert.equal(data.bit_1, true);
		assert.equal(data.bit_8, false);
		assert.deepEqual(events.sort(), ["bit_0", "bit_1", "bit_8", "status"]);
	});

	test("writing a bit updates the word, reported in layout order", () => {
		const data = create_sample();
		const events = [];
		data.on("change", (name, old_value, new_value) => events.push([name, old_value, new_value]));
		data.bit_1 = true;
		assert.equal(data.status, 0x0103);
		assert.deepEqual(events, [["status", 0x0101, 0x0103], ["bit_1", false, true]]);
	});

	test("coupling offset 8..15 is the low byte, 0..7 the high byte", () => {
		const data = create_sample();
		data.status = 0;
		data.bit_8 = true;
		assert.equal(data.status, 0x0100);
		assert.deepEqual([...data.buffer.subarray(2, 4)], [0x01, 0x00]);
	});

	const structs = { LINE, SECTION, NODE, COMMAND, RECORD };
	for (const [struct_name, struct] of Object.entries(structs)) {
		test(`${struct_name}: every tag keeps its init_value after construction`, () => {
			const data = new TData(struct, struct_name);
			for (const item of struct.items) {
				const expected = item.type === "Real" ? Math.fround(item.init_value) : item.init_value;
				assert.equal(data[item.name], expected, `${struct_name}.${item.name}`);
			}
		});
	}
});
