import { assert_exits } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test, { describe } from "node:test";
import { TTag } from "../src/typed_data/TTag.js";

const create_tag = (type, init_value, offset = 0, size = 4) =>
	new TTag(Buffer.alloc(size, 0), "tag", type, offset, init_value);

describe("TTag storage", () => {
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
			const tag = create_tag(type, 0);
			tag.set_value(value);
			assert.equal(tag.value, value);
			assert.equal(tag.get_value(), value);
			assert.deepEqual([...tag.buffer.subarray(0, bytes.length)], bytes);
		});
	}

	test("type name is case-insensitive", () => {
		assert.equal(create_tag("UDInt", 0).type, "udint");
		assert.equal(create_tag("real", 0).type, "real");
	});

	test("tag length follows the type", () => {
		assert.equal(create_tag("Bool", false).length, 1);
		assert.equal(create_tag("Byte", 0).length, 1);
		assert.equal(create_tag("Int", 0).length, 2);
		assert.equal(create_tag("Word", 0).length, 2);
		assert.equal(create_tag("Real", 0).length, 4);
		assert.equal(create_tag("DWord", 0).length, 4);
	});

	test("init_value is written into the buffer", () => {
		const tag = create_tag("Int", -500);
		assert.equal(tag.value, -500);
		assert.deepEqual([...tag.buffer.subarray(0, 2)], [0xfe, 0x0c]);
	});

	test("Real value is rounded to float32 precision", () => {
		const tag = create_tag("Real", 0.1);
		assert.equal(tag.value, Math.fround(0.1));
		let count = 0;
		tag.on("change", () => count++);
		tag.set_value(0.1);
		assert.equal(count, 0);
	});

	test("tag only touches its own bytes", () => {
		const buffer = Buffer.alloc(8, 0xaa);
		const tag = new TTag(buffer, "tag", "Int", 16, 0);
		tag.set_value(0x0102);
		assert.deepEqual([...buffer], [0xaa, 0xaa, 0x01, 0x02, 0xaa, 0xaa, 0xaa, 0xaa]);
	});

	test("out-of-range integer throws RangeError and keeps the old value", () => {
		const tag = create_tag("Int", 1);
		assert.throws(() => tag.set_value(32768), RangeError);
		assert.throws(() => tag.set_value(-32769), RangeError);
		assert.equal(tag.value, 1);
		const utag = create_tag("UDInt", 1);
		assert.throws(() => utag.set_value(-1), RangeError);
		assert.throws(() => utag.set_value(2 ** 32), RangeError);
	});

	test("SInt stores signed values", () => {
		const tag = create_tag("SInt", 0);
		tag.set_value(-1);
		assert.equal(tag.value, -1);
		assert.equal(tag.buffer[0], 0xff);
	});
});

describe("TTag Bool", () => {
	test("bit offset maps to byte offset >> 3 and bit offset % 8", () => {
		const tag = create_tag("Bool", false, 13, 2);
		assert.equal(tag.byte_offset, 1);
		assert.equal(tag.bit_offset, 5);
		assert.equal(tag.bit_mask, 0x20);
	});

	test("setting a bit keeps the other bits of the byte", () => {
		const buffer = Buffer.from([0x00, 0xdf]);
		const tag = new TTag(buffer, "tag", "Bool", 13, false);
		assert.deepEqual([...buffer], [0x00, 0xdf]);
		tag.set_value(true);
		assert.deepEqual([...buffer], [0x00, 0xff]);
		tag.set_value(false);
		assert.deepEqual([...buffer], [0x00, 0xdf]);
	});

	test("truthy and falsy values are normalized to boolean", () => {
		const tag = create_tag("Bool", false, 0, 1);
		tag.set_value(1);
		assert.equal(tag.value, true);
		tag.set_value(0);
		assert.equal(tag.value, false);
	});

	test("read_from and write_to use the same byte index (BE)", () => {
		const tag = create_tag("Bool", false, 10, 2);
		const IO = Buffer.from([0x00, 0x04]);
		tag.read_from(IO, "BE");
		assert.equal(tag.value, true);
		const out = Buffer.from([0xff, 0xff]);
		tag.set_value(false);
		tag.write_to(out, "BE");
		assert.deepEqual([...out], [0xff, 0xfb]);
	});
});

describe("TTag change event", () => {
	test("emits (old, new) after the new value is applied", () => {
		const tag = create_tag("DInt", 1);
		const events = [];
		tag.on("change", (old_value, new_value) => {
			events.push([old_value, new_value, tag.value, tag.get_value()]);
		});
		tag.set_value(2);
		assert.deepEqual(events, [[1, 2, 2, 2]]);
	});

	test("does not emit when the value is unchanged", () => {
		const tag = create_tag("Word", 5);
		let count = 0;
		tag.on("change", () => count++);
		tag.set_value(5);
		assert.equal(count, 0);
	});

	test("check_change detects direct buffer writes", () => {
		const tag = create_tag("UInt", 0);
		const events = [];
		tag.on("change", (...args) => events.push(args));
		tag.buffer.writeUInt16BE(9, 0);
		tag.check_change();
		tag.check_change();
		assert.deepEqual(events, [[0, 9]]);
	});

	test("Bool emits only when its own bit changes", () => {
		const buffer = Buffer.alloc(1);
		const tag = new TTag(buffer, "tag", "Bool", 3, false);
		let count = 0;
		tag.on("change", () => count++);
		buffer[0] = 0xf7; // every bit except bit 3
		tag.check_change();
		assert.equal(count, 0);
		buffer[0] = 0x08;
		tag.check_change();
		assert.equal(count, 1);
	});

	test("repeated NaN emits change only once", () => {
		const tag = create_tag("Real", 0);
		let count = 0;
		tag.on("change", () => count++);
		tag.set_value(Number.NaN);
		tag.set_value(Number.NaN);
		assert.equal(count, 1);
	});
});

describe("TTag endian conversion", () => {
	const cases_2 = [
		["BE", [0x12, 0x34]],
		["LE", [0x34, 0x12]],
		["little", [0x34, 0x12]],
		["BEBS", [0x34, 0x12]],
		["LEBS", [0x12, 0x34]],
	];
	for (const type of ["Int", "UInt", "Word"]) {
		for (const [endian, bytes] of cases_2) {
			test(`${type} ${endian}`, () => {
				const tag = create_tag(type, 0);
				tag.read_from(Buffer.from(bytes), endian);
				assert.equal(tag.value, 0x1234);
				assert.deepEqual([...tag.buffer.subarray(0, 2)], [0x12, 0x34]);
				const out = Buffer.alloc(2);
				tag.write_to(out, endian);
				assert.deepEqual([...out], bytes);
			});
		}
	}

	// internal value ABCD = 0x01020304
	const cases_4 = [
		["BE", [0x01, 0x02, 0x03, 0x04]],
		["LE", [0x04, 0x03, 0x02, 0x01]],
		["little", [0x04, 0x03, 0x02, 0x01]],
		["BEBS", [0x02, 0x01, 0x04, 0x03]],
		["LEBS", [0x03, 0x04, 0x01, 0x02]],
	];
	for (const type of ["DInt", "UDInt", "DWord"]) {
		for (const [endian, bytes] of cases_4) {
			test(`${type} ${endian}`, () => {
				const tag = create_tag(type, 0);
				tag.read_from(Buffer.from(bytes), endian);
				assert.equal(tag.value, 0x01020304);
				const out = Buffer.alloc(4);
				tag.write_to(out, endian);
				assert.deepEqual([...out], bytes);
			});
		}
	}

	for (const [endian, bytes] of cases_4) {
		test(`Real ${endian}`, () => {
			const be = [0x3f, 0xc0, 0x00, 0x01];
			const io = bytes.map((b) => be[b - 1]);
			const tag = create_tag("Real", 0);
			tag.read_from(Buffer.from(io), endian);
			assert.equal(tag.value, Buffer.from(be).readFloatBE());
			const out = Buffer.alloc(4);
			tag.write_to(out, endian);
			assert.deepEqual([...out], io);
		});
	}

	test("read_from uses the tag offset in the IO buffer", () => {
		const tag = new TTag(Buffer.alloc(8), "tag", "UDInt", 32, 0);
		const IO = Buffer.from([0xee, 0xee, 0xee, 0xee, 0x04, 0x03, 0x02, 0x01]);
		tag.read_from(IO, "LE");
		assert.equal(tag.value, 0x01020304);
		assert.deepEqual([...tag.buffer.subarray(0, 4)], [0, 0, 0, 0]);
	});

	test("read_from emits change", () => {
		const tag = create_tag("Int", 0);
		const events = [];
		tag.on("change", (...args) => events.push(args));
		tag.read_from(Buffer.from([0xff, 0xff]), "LE");
		assert.deepEqual(events, [[0, -1]]);
	});
});

describe("TTag single-byte device byte order", () => {
	// [endian, IO index of byte 2, IO index of byte 3]
	const cases = [
		["BE", 2, 3],
		["big", 2, 3],
		["LEBS", 2, 3],
		["LE", 3, 2],
		["little", 3, 2],
		["BEBS", 3, 2],
	];
	for (const [endian, index_2, index_3] of cases) {
		test(`${endian}: byte moves within its 16-bit register only`, () => {
			const buffer = Buffer.alloc(4);
			assert.equal(new TTag(buffer, "b2", "Byte", 16, 0).IO_index(endian), index_2);
			assert.equal(new TTag(buffer, "b3", "Bool", 24, false).IO_index(endian), index_3);
		});

		test(`${endian}: Bool reads and writes only its own bit at the mapped byte`, () => {
			const tag = new TTag(Buffer.alloc(4), "tag", "Bool", 25, false); // byte 3, bit 1
			const IO = Buffer.alloc(4);
			IO[index_3] = 0x02;
			tag.read_from(IO, endian);
			assert.equal(tag.value, true);
			const out = Buffer.alloc(4, 0xf0);
			tag.write_to(out, endian);
			const expected = Buffer.alloc(4, 0xf0);
			expected[index_3] = 0xf2;
			assert.deepEqual([...out], [...expected]);
		});

		test(`${endian}: Byte and SInt read and write the mapped byte`, () => {
			const byte = new TTag(Buffer.alloc(4), "byte", "Byte", 16, 0);
			const sint = new TTag(Buffer.alloc(4), "sint", "SInt", 24, 0);
			const IO = Buffer.alloc(4);
			IO[index_2] = 0x12;
			IO[index_3] = 0xff;
			byte.read_from(IO, endian);
			sint.read_from(IO, endian);
			assert.equal(byte.value, 0x12);
			assert.equal(sint.value, -1);
			const out = Buffer.alloc(4);
			byte.write_to(out, endian);
			sint.write_to(out, endian);
			assert.deepEqual([...out], [...IO]);
		});
	}

	test("IO_range maps single-byte tags and keeps multi-byte tags in place", () => {
		const buffer = Buffer.alloc(8);
		assert.deepEqual(new TTag(buffer, "b", "Bool", 24, false).IO_range("LE"), { start: 2, end: 3 });
		assert.deepEqual(new TTag(buffer, "b", "Bool", 24, false).IO_range("BE"), { start: 3, end: 4 });
		assert.deepEqual(new TTag(buffer, "w", "Word", 16, 0).IO_range("LE"), { start: 2, end: 4 });
		assert.deepEqual(new TTag(buffer, "r", "Real", 32, 0).IO_range("BEBS"), { start: 4, end: 8 });
	});
});

describe("TTag validation", () => {
	test("non-Bool tag with a bit offset exits", (t) => {
		assert_exits(t, () => create_tag("Int", 0, 3));
	});

	test("multi-byte tag at an odd byte offset exits", (t) => {
		assert_exits(t, () => create_tag("Int", 0, 8));
		assert_exits(t, () => create_tag("Real", 0, 24, 8));
	});

	test("Byte tag at an odd byte offset is accepted", () => {
		const tag = create_tag("Byte", 7, 8, 2);
		assert.equal(tag.byte_offset, 1);
		assert.equal(tag.buffer[1], 7);
	});

	test("SInt read_from/write_to copy the byte unchanged", () => {
		const tag = create_tag("SInt", 0, 8, 2);
		tag.read_from(Buffer.from([0x00, 0x80]), "BE");
		assert.equal(tag.value, -128);
		const out = Buffer.alloc(2);
		tag.set_value(-2);
		tag.write_to(out, "BE");
		assert.deepEqual([...out], [0x00, 0xfe]);
	});

	test("SInt and USInt at an odd byte offset are accepted", () => {
		assert.equal(create_tag("USInt", 7, 8, 2).buffer[1], 7);
		assert.equal(create_tag("SInt", 7, 8, 2).buffer[1], 7);
	});

	test("unknown type exits", (t) => {
		assert_exits(t, () => create_tag("LReal", 0));
	});

	test("init_value that is not a number or boolean exits", (t) => {
		assert_exits(t, () => create_tag("Int", undefined));
		assert_exits(t, () => create_tag("Int", "1"));
	});
});
