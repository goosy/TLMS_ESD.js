// Shared helpers for the typed data tests.
// Import this module before any module under src/ so that LOG_LEVEL is set
// before src/util.js configures log4js.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

process.env.LOG_LEVEL ??= "off";
// imported after LOG_LEVEL is set: it loads src/util.js through TData
const { build_structure } = await import("../src/typed_data/structure.js");
const { TData } = await import("../src/typed_data/TData.js");

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
 * Builds a data structure from a fresh copy of items,
 * because build_structure mutates the items it receives.
 */
export function make_struct(items, name = "TEST") {
	return build_structure({ name }, structuredClone(items));
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

/** A data block of `size` bytes with one tag named "tag". */
export function one_tag(type, init_value, offset = 0, size = 4) {
	return new TData({
		name: "T",
		length: size * 8,
		items: [{ name: "tag", type, offset, init_value }],
	}, "t");
}
