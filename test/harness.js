// System test harness: builds the controller runtime from a fixture
// configuration with fake actuator drivers, drives HMI writes through the
// upward server vector and advances mocked time.
//
// Tests written against this harness only set inputs (actuator memory,
// HMI writes, driver events), advance time and check outputs, so that they
// stay valid while the internal scheduling of the controller changes.
import "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { read_config, MAIN_PERIOD } from "../src/config.js";
import { prepare_controller } from "../src/init.js";
import { build_runtime } from "../src/runtime.js";
import { create_vector } from "../src/typed_data/server.js";
import { TData } from "../src/typed_data/TData.js";
import { LINE, SECTION, NODE, COMMAND, RECORD } from "../src/layouts.js";

export { MAIN_PERIOD };

const FIXTURE_DIR = join(import.meta.dirname, "fixtures/system");
// local byte where the command block is bound to the actuator (node_proc.js)
const COMMAND_LOCAL_START = 16;
// byte where the command block is attached in a node unit (runtime.js)
const COMMAND_UNIT_START = 400;
const TIME_STEP = 10;
// longer than the parameter refresh 2 s after connecting (node_proc.js)
const STARTUP_MS = 3000;
const REMOTE_SIZE = 2048;

let config_loaded = null;
// the configuration modules keep global tables: load the fixture once per process
const load_config = () => config_loaded ??= read_config(FIXTURE_DIR);

// ---------------------------------------------------------------------------
// Device byte order: an oracle independent of src/typed_data

const SWAP_REGISTER = ["LE", "little", "BEBS"];

/**
 * Positions in a device-ordered area of the big-endian bytes of a value.
 * Returns io[k]: where big-endian byte k of the value is stored.
 */
function io_positions(byte, size, endian) {
	if (size === 1) return [SWAP_REGISTER.includes(endian) ? byte ^ 1 : byte];
	if (size === 2) return SWAP_REGISTER.includes(endian) ? [byte + 1, byte] : [byte, byte + 1];
	switch (endian) {
		case "LE":
		case "little": return [byte + 3, byte + 2, byte + 1, byte];
		case "BEBS": return [byte + 1, byte, byte + 3, byte + 2];
		case "LEBS": return [byte + 2, byte + 3, byte, byte + 1];
		default: return [byte, byte + 1, byte + 2, byte + 3];
	}
}

const CODEC = {
	byte: [1, "UInt8"], usint: [1, "UInt8"], sint: [1, "Int8"],
	int: [2, "Int16BE"], uint: [2, "UInt16BE"], word: [2, "UInt16BE"],
	dint: [4, "Int32BE"], udint: [4, "UInt32BE"], dword: [4, "UInt32BE"],
	real: [4, "FloatBE"],
};

export function item_of(struct, name) {
	const item = struct.items.find((it) => it.name === name);
	if (!item) throw new Error(`${struct.name} has no item ${name}`);
	return item;
}

/** Big-endian bytes of a non-Bool value. */
function encode(type, value) {
	const [size, method] = CODEC[type];
	const bytes = Buffer.alloc(size);
	bytes[`write${method}`](value);
	return bytes;
}

function decode(type, bytes) {
	const [, method] = CODEC[type];
	return bytes[`read${method}`]();
}

/**
 * Writes an item of a layout into a device-ordered area.
 * `base` is the area byte that holds local byte `local_start`.
 */
function write_item(area, base, local_start, endian, item, value) {
	const type = item.type.toLowerCase();
	const byte = item.offset >> 3;
	if (type === "bool") {
		const [pos] = io_positions(byte - local_start, 1, endian);
		const mask = 1 << (item.offset % 8);
		area[base + pos] = value ? area[base + pos] | mask : area[base + pos] & ~mask;
		return;
	}
	const bytes = encode(type, value);
	const positions = io_positions(byte - local_start, bytes.length, endian);
	positions.forEach((pos, k) => { area[base + pos] = bytes[k]; });
}

function read_item(area, base, local_start, endian, item) {
	const type = item.type.toLowerCase();
	const byte = item.offset >> 3;
	if (type === "bool") {
		const [pos] = io_positions(byte - local_start, 1, endian);
		return (area[base + pos] & (1 << (item.offset % 8))) !== 0;
	}
	const size = CODEC[type][0];
	const positions = io_positions(byte - local_start, size, endian);
	return decode(type, Buffer.from(positions.map((pos) => area[base + pos])));
}

// ---------------------------------------------------------------------------
// Fake actuator drivers

/**
 * A driver stub with one memory area per extras key (Modbus unit id, or
 * S7 area and db), emitting the same events as the real drivers.
 */
export class Fake_Driver extends EventEmitter {
	// like a real driver, not connected until started and connected
	is_connected = false;
	read_failing = false;
	writes = [];

	constructor(write_unit) {
		super();
		this.write_unit = write_unit;
		this.memory = new Map();
		this.setMaxListeners(50);
	}

	area(...extras) {
		const key = extras.join(":");
		if (!this.memory.has(key)) this.memory.set(key, Buffer.alloc(REMOTE_SIZE));
		return this.memory.get(key);
	}

	start() { }

	async read({ start, length }, ...extras) {
		if (!this.is_connected || this.read_failing) return null;
		return Buffer.from(this.area(...extras).subarray(start, start + length));
	}

	async write(buffer, { start, length }, ...extras) {
		if (!this.is_connected) return false;
		this.writes.push({ start, length, extras, bytes: [...buffer] });
		buffer.copy(this.area(...extras), start, 0, length);
		return true;
	}

	/** The connection is lost: reads fail and `connfailed` is emitted. */
	lose_connection() {
		this.is_connected = false;
		this.emit("connfailed", "connection lost");
	}

	restore_connection() {
		this.is_connected = true;
		this.emit("connect");
	}

	/** Reads keep failing while connected, as an `io_error`. */
	fail_reads() {
		this.read_failing = true;
		this.emit("io_error", "read failed");
	}

	restore_reads() {
		this.read_failing = false;
		this.emit("io_ok");
	}
}

/** The actuator side of a node: its data and command areas in device order. */
class Device {
	constructor(node, driver) {
		const info = node.driver_info;
		this.driver = driver;
		this.endian = info.endian;
		const extras = (area) => info.protocol === "S7"
			? [info[area].area, info[area].db]
			: [info[area].unit_id];
		this.data_area = driver.area(...extras("data"));
		this.data_start = info.data.start;
		this.command_area = driver.area(...extras("commands"));
		this.command_start = info.commands.start;
		this.command_extras = extras("commands");
		this.data_extras = extras("data");
	}

	/**
	 * Sets a NODE item reported by the actuator. Like a real actuator, it
	 * reports `pump_run` as the "or" of the states of its pumps.
	 */
	set(name, value) {
		write_item(this.data_area, this.data_start, 0, this.endian, item_of(NODE, name), value);
		if (/^pump_run_\d$/.test(name)) {
			const pumps = ["pump_run_1", "pump_run_2", "pump_run_3", "pump_run_4"];
			this.set("pump_run", pumps.some((pump) => this.get(pump)));
		}
	}

	get(name) {
		return read_item(this.data_area, this.data_start, 0, this.endian, item_of(NODE, name));
	}

	/** Reads a COMMAND item as last written by the controller. */
	command(name) {
		return read_item(
			this.command_area, this.command_start, COMMAND_LOCAL_START,
			this.endian, item_of(COMMAND, name),
		);
	}

	/** Writes to the command area of this device so far. */
	command_writes() {
		const key = this.command_extras.join(":");
		return this.driver.writes.filter((w) => w.extras.join(":") === key
			&& w.start >= this.command_start && w.start < this.command_start + 200);
	}

	/** Writes to the data area (parameter block) of this device so far. */
	data_writes() {
		const key = this.data_extras.join(":");
		return this.driver.writes.filter((w) => w.extras.join(":") === key
			&& w.start >= this.data_start && w.start < this.data_start + 200);
	}
}

// ---------------------------------------------------------------------------
// System

/**
 * Builds a running controller from the fixture configuration.
 * Must be called inside a test: it enables mocked timers on `t`.
 */
export async function create_system(t) {
	await load_config();
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

	const controller = await prepare_controller("TC");
	const drivers = new Map();
	const get_driver = (key, write_unit) => {
		if (!drivers.has(key)) drivers.set(key, new Fake_Driver(write_unit));
		return drivers.get(key);
	};
	const get_drivers = (info) => {
		const driver = info.protocol === "S7"
			? get_driver(`s7:${info.host}:${info.port}`, 1)
			: get_driver(`mb:${info.IP}:${info.data.port}`, 2);
		return { data_driver: driver, command_driver: driver };
	};

	const records = [];
	const record_names = RECORD.items.map((item) => item.name);
	// like Action_Record: the fields of a record, without the words and the index
	const field_names = RECORD.items
		.filter((item) => item.type.toLowerCase() !== "word" && item.name !== "index")
		.map((item) => item.name);
	// like main.js: its writes request a scan of the runtime built below
	let runtime;
	const action_record = {
		data: new TData(RECORD, "action_records", { on_write: () => runtime?.scheduler.request_scan() }),
		update_record(fields) {
			for (const [name, value] of Object.entries(fields)) this.data[name] = value;
			this.add_record();
		},
		add_record() {
			const record = {};
			for (const name of record_names) record[name] = this.data[name];
			records.push(record);
			this.data.index = 0;
		},
		// index 0 is the latest record
		get(index) {
			const record = records.at(-1 - index);
			if (index < 0 || !record) return false;
			for (const name of field_names) this.data[name] = record[name];
			return true;
		},
	};

	runtime = build_runtime(controller, { get_drivers, action_record });
	// every system test checks the declared dependencies of the rules (doc/design.md 6.5)
	const undeclared = runtime.scheduler.trace_dependencies();
	t.after(() => {
		runtime.scheduler.untrace_dependencies();
		assert.deepEqual(undeclared, [], "rules access tags they do not declare");
	});
	// actuators report their initial values before the controller starts
	const devices = new Map();
	for (const node of runtime.nodes) {
		const device = new Device(node, node.data_driver);
		for (const item of NODE.items) {
			if (item.coupling?.length && item.type.toLowerCase() === "word") continue;
			device.set(item.name, item.init_value);
		}
		device.set("ID", node.ID);
		devices.set(node.name, device);
	}
	for (const driver of drivers.values()) driver.restore_connection();
	runtime.start();
	t.after(() => runtime.stop());

	const vector = create_vector(runtime.unit_map);
	const unit_ids = controller.modbus_server.unit_id;
	const find = (list, name) => {
		const found = list.find((it) => it.name === name);
		if (!found) throw new Error(`no ${name}`);
		return found;
	};

	/** Where a data block sits on the upward server. */
	const target = (name, block = "data") => {
		const unit_id = unit_ids[name];
		if (name === "action_records") return { unit_id, struct: RECORD, start: 0 };
		if (runtime.lines.some((it) => it.name === name)) return { unit_id, struct: LINE, start: 0 };
		if (runtime.sections.some((it) => it.name === name)) return { unit_id, struct: SECTION, start: 0 };
		return block === "command"
			? { unit_id, struct: COMMAND, start: COMMAND_UNIT_START }
			: { unit_id, struct: NODE, start: 0 };
	};

	const hmi = {
		vector,
		/**
		 * Writes a TTag as an HMI would: a Bool with FC 5 (one coil), any other
		 * type with FC 16 (consecutive registers in one request).
		 */
		set(name, tag, value, block = "data") {
			const { unit_id, struct, start } = target(name, block);
			const item = item_of(struct, tag);
			const byte = start + (item.offset >> 3);
			if (item.type.toLowerCase() === "bool") {
				vector.set_coil(byte * 8 + item.offset % 8, Boolean(value), unit_id);
				return;
			}
			const bytes = encode(item.type.toLowerCase(), value);
			if (bytes.length === 1) throw new Error("single-byte tags are written through their register");
			for (let k = 0; k < bytes.length; k += 2) {
				vector.set_register((byte + k) >> 1, bytes.readUInt16BE(k), unit_id);
			}
		},
		/** Writes raw registers as one FC 16 request. */
		write_registers(name, addr, values, block = "data") {
			const { unit_id, start } = target(name, block);
			values.forEach((value, k) => vector.set_register((start >> 1) + addr + k, value, unit_id));
		},
		get(name, tag, block = "data") {
			const { unit_id, struct, start } = target(name, block);
			const item = item_of(struct, tag);
			const byte = start + (item.offset >> 3);
			if (item.type.toLowerCase() === "bool") {
				return Boolean(vector.get_coil(byte * 8 + item.offset % 8, unit_id));
			}
			const size = CODEC[item.type.toLowerCase()][0];
			const bytes = Buffer.alloc(Math.max(size, 2));
			for (let k = 0; k < bytes.length; k += 2) {
				bytes.writeUInt16BE(vector.get_holding_register((byte + k) >> 1, unit_id), k);
			}
			return decode(item.type.toLowerCase(), bytes);
		},
	};

	const flush = async () => {
		for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
	};

	const system = {
		controller,
		runtime,
		records,
		hmi,
		line: (name) => find(runtime.lines, name),
		section: (name) => find(runtime.sections, name),
		node: (name) => find(runtime.nodes, name),
		device: (name) => devices.get(name),
		driver: (name) => find(runtime.nodes, name).data_driver,
		/** Lets pending IO and triggered scans complete, without advancing time. */
		flush,
		/** Advances mocked time by `ms`, letting pending IO settle in between. */
		async advance(ms) {
			for (let elapsed = 0; elapsed < ms; elapsed += TIME_STEP) {
				t.mock.timers.tick(TIME_STEP);
				await flush();
			}
		},
		/** Advances a few main periods: long enough for any change to propagate. */
		async settle() {
			await this.advance(3 * MAIN_PERIOD);
		},
	};
	// tests start from the steady state after startup
	await system.advance(STARTUP_MS);
	return system;
}
