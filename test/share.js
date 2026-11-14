// Shared helpers for the tests.
// Import this module before any module under src/ so that LOG_LEVEL is set
// before src/util.js configures log4js.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

process.env.LOG_LEVEL ??= "off";
import { create_scope, desc_file, get_scope, yaml } from "modbus-emulator";
import { LAYOUT_SCOPE, layouts_file } from "../src/layouts.js";

export class Exit_Called extends Error {
	constructor(code) {
		super(`process.exit(${code})`);
		this.code = code;
	}
}

/**
 * Asserts that fn calls process.exit(1). process.exit is mocked to throw
 * Exit_Called, so the remaining code after the exit point does not run.
 */
export function mock_exit(t) {
	t.mock.method(process, "exit", (code) => {
		throw new Exit_Called(code);
	});
}

const is_exit_1 = (err) => err instanceof Exit_Called && err.code === 1;

export function assert_exits(t, fn) {
	mock_exit(t);
	assert.throws(fn, is_exit_1);
}

/** Same as assert_exits, for an async fn whose promise rejects at the exit point. */
export async function assert_exits_async(t, fn) {
	mock_exit(t);
	await assert.rejects(fn, is_exit_1);
}

/**
 * Registers the layouts of the controller and the layouts of the test file
 * (by name, from items) in the scope of the controller in one call, because
 * a scope registers its layouts once. A test file calls it once, at its top
 * level.
 *
 * @param {Object<string, Object[]>} [layouts] - The items of the layouts of the test file.
 */
export function register_test_layouts(layouts = {}) {
	// JSON is YAML: the description of the test layouts is made by yaml
	const own = yaml(JSON.stringify({ layouts: Object.keys(layouts), item_tables: layouts }));
	create_scope(LAYOUT_SCOPE).load([desc_file(layouts_file), own]);
}

/** The registered layout of the name in the scope of the controller. */
export function get_layout(name) {
	return get_scope(LAYOUT_SCOPE).get_layout(name);
}

/** Creates a data block of the registered layout. */
export function create_block(layout_name, name) {
	// a layout keeps its data blocks by name: free the name of an earlier block of the test file
	const layout = get_layout(layout_name);
	layout.delete_ldata(name);
	return layout.create_ldata(name);
}

/** Registers the layouts of the controller and returns them by name. */
export function controller_layouts() {
	register_test_layouts();
	return Object.fromEntries(["LINE", "SECTION", "NODE", "COMMAND", "RECORD"].map((name) => [name, get_layout(name)]));
}

/**
 * A driver stub backed by a remote memory buffer.
 * write() resolves with the next value of write_results (default true).
 */
export function create_fake_driver(write_unit = 1, remote_size = 256) {
	return {
		is_connected: true,
		write_unit,
		remote: Buffer.alloc(remote_size, 0),
		reads: [],
		writes: [],
		read_result: undefined,
		write_results: [],
		async read({ start, length }, ...extras) {
			this.reads.push({ start, length, extras });
			if (this.read_result !== undefined) return this.read_result;
			return Buffer.from(this.remote.subarray(start, start + length));
		},
		async write(buffer, { start, length }, ...extras) {
			this.writes.push({ start, length, bytes: [...buffer], extras });
			buffer.copy(this.remote, start);
			return this.write_results.shift() ?? true;
		},
	};
}

/**
 * Reads the device of a binding group and loads the group, as the input
 * phase of a scan would do.
 * @returns {Promise<boolean>} Whether the read succeeded.
 */
export async function read_group(group) {
	const { binding } = group;
	if (!await binding.request_read()) return false;
	binding.load(group);
	return true;
}

/** Writes a binding group to the device at once, as the output phase of a scan. */
export function write_group(group) {
	group.binding.request_write(group);
	return group.binding.flush_writes();
}
