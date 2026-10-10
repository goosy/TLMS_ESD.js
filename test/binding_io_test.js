import { create_fake_driver, make_struct, read_group, write_group } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import test, { describe } from "node:test";
import { TData } from "../src/typed_data/TData.js";
import { Binding } from "../src/drivers/binding.js";
import { load_entry, store_entry } from "../src/typed_data/endian.js";
import { NODE, COMMAND, SECTION, node_parameters } from "../src/layouts.js";

describe("Binding exchange area", () => {
	const SAMPLE = [
		{ name: "id", type: "UInt", offset: 0, length: 16, init_value: 7 },
		{ name: "x", type: "UInt", offset: 16, length: 16, init_value: 0 },
		{ name: "y", type: "UDInt", offset: 32, length: 32, init_value: 0 },
		{ name: "z", type: "UInt", offset: 64, length: 16, init_value: 0 },
		{ name: "w", type: "UInt", offset: 80, length: 16, init_value: 0 },
	];
	// data bytes [2, 10) map to remote bytes [100, 108)
	const setup = (driver = create_fake_driver()) => {
		const data = new TData(make_struct(SAMPLE), "sample");
		const binding = new Binding(data, driver, { remote_start: 100, start: 2, length: 8, endian: "BE" }, "extra");
		return { data, driver, binding };
	};

	test("a read takes the whole exchange area at the mapped remote address", async () => {
		const { data, driver, binding } = setup();
		for (let i = 0; i < 8; i++) driver.remote[100 + i] = i + 1;
		assert.equal(await binding.request_read(), true);
		assert.deepEqual(driver.reads, [{ start: 100, length: 8, extras: ["extra"] }]);
		assert.deepEqual([...binding.IO_buffer], [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0]);
		// a read does not touch the data block until loaded
		assert.equal(binding.fresh, true);
		assert.equal(data.x, 0);
		binding.load(binding.create_group("x"));
		assert.equal(binding.fresh, false);
		assert.equal(data.x, 0x0102);
	});

	test("a write goes to the mapped remote address with the extras", async () => {
		const { data, driver, binding } = setup();
		data.z = 0x0102;
		assert.equal(await write_group(binding.create_group("z")), true);
		assert.deepEqual(driver.writes, [{ start: 106, length: 2, bytes: [1, 2], extras: ["extra"] }]);
	});

	test("defaults: start 0, remote_start 0, length to the end, endian BE", async () => {
		const data = new TData(make_struct(SAMPLE), "sample");
		const driver = create_fake_driver();
		const binding = new Binding(data, driver);
		assert.equal(binding.endian, "BE");
		await binding.request_read();
		assert.deepEqual(driver.reads[0], { start: 0, length: 12, extras: [] });
	});

	test("nothing is exchanged while the driver is not connected; write requests are kept", async () => {
		const { data, driver, binding } = setup();
		driver.is_connected = false;
		const group = binding.create_group("z");
		data.z = 5;
		assert.equal(await binding.request_read(), false);
		assert.equal(await write_group(group), false);
		assert.equal(driver.reads.length + driver.writes.length, 0);
		driver.is_connected = true;
		assert.equal(await binding.flush_writes(), true);
		assert.deepEqual(driver.writes.map(({ start, bytes }) => [start, bytes]), [[106, [0, 5]]]);
	});

	test("a failed read returns false, keeps the values and clears read_ok", async () => {
		const { data, driver, binding } = setup();
		driver.read_result = null;
		assert.equal(await read_group(binding.create_group("x")), false);
		assert.equal(binding.read_ok, false);
		assert.equal(data.x, 0);
		driver.read_result = undefined;
		assert.equal(await binding.request_read(), true);
		assert.equal(binding.read_ok, true);
	});

	test("a read in progress is shared", async () => {
		const { driver, binding } = setup();
		const first = binding.request_read();
		const second = binding.request_read();
		assert.equal(first, second);
		await first;
		assert.equal(driver.reads.length, 1);
	});

	test("write requests of a group before a flush write once; write_done counts the writes", async () => {
		const { driver, binding } = setup();
		const group = binding.create_group("x");
		binding.request_write(group);
		binding.request_write(group);
		assert.equal(binding.write_done(group), undefined);
		await binding.flush_writes();
		assert.equal(driver.writes.length, 1);
		assert.deepEqual(binding.write_done(group), { seq: 1, ok: true });
		driver.write_results = [false];
		await write_group(group);
		assert.deepEqual(binding.write_done(group), { seq: 2, ok: false });
	});

	test("the connection state follows the driver events; on_update reports data and changes", async () => {
		const driver = Object.assign(new EventEmitter(), create_fake_driver());
		const updates = [];
		const data = new TData(make_struct(SAMPLE), "sample");
		const binding = new Binding(data, driver, { on_update: (b) => updates.push(b) });
		assert.equal(binding.connected, true);
		driver.emit("connfailed", "lost");
		assert.equal(binding.connected, false);
		driver.emit("connfailed", "still lost");
		driver.emit("connect");
		assert.equal(binding.connected, true);
		await binding.request_read();
		await write_group(binding.create_group("id"));
		// connfailed, connect, read, write
		assert.equal(updates.length, 4);
		assert.ok(updates.every((b) => b === binding));
	});
});

describe("Binding byte order equivalence", () => {
	// The reference is the per-tag conversion of endian.js, moved unchanged from TTag.
	const random_fill = (buffer) => {
		for (let i = 0; i < buffer.length; i++) buffer[i] = Math.floor(Math.random() * 256);
	};
	const parameter_names = node_parameters.map((it) => it.name);
	const groups = {
		NODE_payload: {
			struct: NODE,
			start: 0,
			names: NODE.items.map((it) => it.name).filter((name) => name !== "comm_OK" && name !== "status"),
		},
		NODE_parameters: { struct: NODE, start: 0, names: parameter_names },
		COMMAND_payload: { struct: COMMAND, start: 16, names: ["ID", "commands", ...parameter_names] },
		SECTION_mixed: { struct: SECTION, start: 0, names: ["comm_OK", "pump_run", "flow_alarm_F", "countdown", "flow_diff"] },
	};
	for (const [group_name, { struct, start, names }] of Object.entries(groups)) {
		for (const endian of ["BE", "big", "LE", "little", "BEBS", "LEBS"]) {
			for (const write_unit of [1, 2]) {
				test(`${group_name} ${endian}, write unit ${write_unit}`, async () => {
					for (let round = 0; round < 20; round++) {
						const data = new TData(struct, "new");
						const reference = new TData(struct, "reference");
						const driver = create_fake_driver(write_unit, 2048);
						const binding = new Binding(data, driver, { start, length: data.size - start, endian });
						const group = binding.create_group(...names);

						// load: random device data into random data blocks
						random_fill(data.buffer);
						data.buffer.copy(reference.buffer);
						random_fill(binding.IO_buffer);
						const io = Buffer.from(binding.IO_buffer);
						binding.load(group);
						for (const entry of group.entries) load_entry(entry, io, reference.buffer, endian);
						assert.deepEqual([...data.buffer], [...reference.buffer]);

						// store: random data blocks exported into the device-ordered buffer
						random_fill(data.buffer);
						data.buffer.copy(reference.buffer);
						const io_reference = Buffer.from(binding.IO_buffer);
						for (const entry of group.entries) store_entry(entry, reference.buffer, io_reference, endian);
						binding.request_write(group);
						await binding.flush_writes();
						assert.deepEqual([...binding.IO_buffer], [...io_reference]);
						// remote_start is 0: remote byte r is IO byte r + start
						for (const { start: remote, bytes } of driver.writes) {
							const at = remote + start;
							assert.deepEqual(bytes, [...io_reference.subarray(at, at + bytes.length)]);
						}
					}
				});
			}
		}
	}
});
