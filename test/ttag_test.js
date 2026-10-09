import { one_tag } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { TTag } from "../src/typed_data/TTag.js";

describe("tag storage", () => {
	const cases = [
		// type, value, expected internal big-endian bytes
		["Byte", 255, [0xff]],
		["USInt", 200, [0xc8]],
		["Int", -2, [0xff, 0xfe]],
		["Int", 32767, [0x7f, 0xff]],
		["Int", -32768, [0x80, 0x00]],
		["UInt", 65535, [0xff, 0xff]],
		["Word", 0x1234, [0x12, 0x34]],
		["DInt", -1, [0xff, 0xff, 0xff, 0xff]],
		["DInt", -2147483648, [0x80, 0x00, 0x00, 0x00]],
		["UDInt", 4294967295, [0xff, 0xff, 0xff, 0xff]],
		["DWord", 0x01020304, [0x01, 0x02, 0x03, 0x04]],
		["Real", 1.5, [0x3f, 0xc0, 0x00, 0x00]],
		["Real", -100000, [0xc7, 0xc3, 0x50, 0x00]],
	];
	for (const [type, value, bytes] of cases) {
		test(`${type} ${value} is stored big-endian`, () => {
			const data = one_tag(type, 0);
			data.tag = value;
			assert.equal(data.tag, value);
			assert.equal(data.get("tag").value, value);
			assert.deepEqual([...data.buffer.subarray(0, bytes.length)], bytes);
		});
	}

	test("type name is case-insensitive", () => {
		assert.equal(one_tag("UDInt", 0).get("tag").type, "udint");
		assert.equal(one_tag("real", 0).get("tag").type, "real");
	});

	test("tag length in bytes follows the type", () => {
		assert.equal(one_tag("Bool", false).get("tag").length, 1);
		assert.equal(one_tag("Byte", 0).get("tag").length, 1);
		assert.equal(one_tag("Int", 0).get("tag").length, 2);
		assert.equal(one_tag("Word", 0).get("tag").length, 2);
		assert.equal(one_tag("Real", 0).get("tag").length, 4);
		assert.equal(one_tag("DWord", 0).get("tag").length, 4);
	});

	test("init_value is written into the buffer", () => {
		const data = one_tag("Int", -500);
		assert.equal(data.tag, -500);
		assert.deepEqual([...data.buffer.subarray(0, 2)], [0xfe, 0x0c]);
	});

	test("Real value is rounded to float32 precision", () => {
		const data = one_tag("Real", 0.1);
		assert.equal(data.tag, Math.fround(0.1));
		let count = 0;
		data.get("tag").on("change", () => count++);
		data.tag = 0.1;
		assert.equal(count, 0);
	});

	test("tag only touches its own bytes", () => {
		const data = one_tag("Int", 0, 16, 8);
		data.buffer.fill(0xaa);
		data.tag = 0x0102;
		assert.deepEqual([...data.buffer], [0xaa, 0xaa, 0x01, 0x02, 0xaa, 0xaa, 0xaa, 0xaa]);
	});

	test("out-of-range integer throws RangeError and keeps the old value", () => {
		const data = one_tag("Int", 1);
		assert.throws(() => { data.tag = 32768; }, RangeError);
		assert.throws(() => { data.tag = -32769; }, RangeError);
		assert.equal(data.tag, 1);
		const udata = one_tag("UDInt", 1);
		assert.throws(() => { udata.tag = -1; }, RangeError);
		assert.throws(() => { udata.tag = 2 ** 32; }, RangeError);
	});

	test("SInt stores signed values", () => {
		const data = one_tag("SInt", 0);
		data.tag = -1;
		assert.equal(data.tag, -1);
		assert.equal(data.buffer[0], 0xff);
	});

	test("Byte, SInt and USInt at an odd byte offset are accepted", () => {
		assert.equal(one_tag("Byte", 7, 8, 2).buffer[1], 7);
		assert.equal(one_tag("USInt", 7, 8, 2).buffer[1], 7);
		assert.equal(one_tag("SInt", -1, 8, 2).buffer[1], 0xff);
	});
});

describe("Bool tag", () => {
	test("bit offset maps to byte offset >> 3 and bit offset % 8", () => {
		const { entry } = one_tag("Bool", false, 13, 2).get("tag");
		assert.equal(entry.byte, 1);
		assert.equal(entry.mask, 0x20);
	});

	test("setting a bit keeps the other bits of the byte", () => {
		const data = one_tag("Bool", false, 13, 2);
		data.buffer[1] = 0xdf;
		data.tag = true;
		assert.deepEqual([...data.buffer], [0x00, 0xff]);
		data.tag = false;
		assert.deepEqual([...data.buffer], [0x00, 0xdf]);
	});

	test("truthy and falsy values are normalized to boolean", () => {
		const data = one_tag("Bool", false, 0, 2);
		data.tag = 1;
		assert.equal(data.tag, true);
		data.tag = 0;
		assert.equal(data.tag, false);
	});
});

describe("tag change event", () => {
	test("emits (old, new) after the new value is applied", () => {
		const data = one_tag("DInt", 1);
		const events = [];
		data.get("tag").on("change", (old_value, new_value) => {
			events.push([old_value, new_value, data.tag, data.get("tag").value]);
		});
		data.tag = 2;
		assert.deepEqual(events, [[1, 2, 2, 2]]);
	});

	test("does not emit when the value is unchanged", () => {
		const data = one_tag("Word", 5);
		let count = 0;
		data.get("tag").on("change", () => count++);
		data.tag = 5;
		assert.equal(count, 0);
	});

	test("detect() reports direct buffer writes once", () => {
		const data = one_tag("UInt", 0);
		const events = [];
		data.get("tag").on("change", (...args) => events.push(args));
		data.buffer.writeUInt16BE(9, 0);
		data.detect();
		data.detect();
		assert.deepEqual(events, [[0, 9]]);
	});

	test("Bool emits only when its own bit changes", () => {
		const data = one_tag("Bool", false, 3, 2);
		let count = 0;
		data.get("tag").on("change", () => count++);
		data.buffer[0] = 0xf7; // every bit except bit 3
		data.detect();
		assert.equal(count, 0);
		data.buffer[0] = 0x08;
		data.detect();
		assert.equal(count, 1);
	});

	test("repeated NaN emits change only once", () => {
		const data = one_tag("Real", 0);
		let count = 0;
		data.get("tag").on("change", () => count++);
		data.tag = Number.NaN;
		data.tag = Number.NaN;
		assert.equal(count, 1);
	});
});

describe("TTag handle", () => {
	test("is created once per tag and holds no value of its own", () => {
		const data = one_tag("Int", 3);
		const tag = data.get("tag");
		assert.ok(tag instanceof TTag);
		assert.equal(data.get("tag"), tag);
		assert.equal(tag.name, "tag");
		data.buffer.writeInt16BE(-4, 0);
		assert.equal(tag.value, -4);
	});

	test("get() returns undefined for an unknown name", () => {
		assert.equal(one_tag("Int", 0).get("nope"), undefined);
	});
});

describe("layout checks of a data block", () => {
	test("non-Bool tag with a bit offset throws", () => {
		assert.throws(() => one_tag("Int", 0, 3), /bit offset 3/);
	});

	test("multi-byte tag at an odd byte offset throws", () => {
		assert.throws(() => one_tag("Int", 0, 8), /odd byte 1/);
		assert.throws(() => one_tag("Real", 0, 24, 8), /odd byte 3/);
	});

	test("unknown type throws", () => {
		assert.throws(() => one_tag("LReal", 0), /unknown tag type LReal/);
	});

	test("init_value that is not a number or boolean throws", () => {
		assert.throws(() => one_tag("Int", undefined), /init_value/);
		assert.throws(() => one_tag("Int", "1"), /init_value/);
	});
});
