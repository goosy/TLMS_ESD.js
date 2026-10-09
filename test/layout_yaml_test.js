import "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { compile_layout } from "../src/typed_data/layout.js";
import { TData } from "../src/typed_data/TData.js";
import { NODE, COMMAND, node_parameters } from "../src/layouts.js";

const dir = mkdtempSync(join(tmpdir(), "tlms-layout-"));
let file_seq = 0;

/** Writes a YAML layout file and compiles it. */
function compile(yaml) {
	const file = join(dir, `layout_${++file_seq}.yaml`);
	writeFileSync(file, yaml);
	return compile_layout(file);
}

function errors_of(yaml) {
	try {
		compile(yaml);
	} catch (e) {
		return e.errors;
	}
	assert.fail("the layout was accepted");
}

const SAMPLE = `
flags:
  - { name: f0, type: Bool, offset: 8, init_value: true }
  - { name: f8, type: Bool, offset: 0, init_value: false, comment: high byte bit }

pair:
  - { name: a, type: Int, offset: 0, init_value: -2 }
  - { name: b, type: Real, offset: 16, init_value: 1.5 }

layouts:
  T:
    - { name: id, type: UInt, offset: 0, init_value: 7 }
    - name: status
      type: Word
      offset: 16
      is_combined: true
      coupling: flags
    - name: inline
      type: Word
      offset: 32
      init_value: 1
      coupling:
        - { name: i0, type: Bool, offset: 8 }
        - { name: i8, type: Bool, offset: 0 }
    - { includes: pair, offset: 48 }
    - { includes: pair, offset: 112, name_prefix: p_ }
`;

describe("YAML layout file", () => {
	test("fragments are referenced by name from coupling and includes", () => {
		const { layouts, fragments } = compile(SAMPLE);
		const { T } = layouts;
		const offset_of = (name) => T.items.find((it) => it.name === name).offset;
		assert.equal(offset_of("f0"), 24);
		assert.equal(offset_of("f8"), 16);
		assert.equal(offset_of("i0"), 40);
		assert.equal(offset_of("a"), 48);
		assert.equal(offset_of("b"), 64);
		assert.equal(offset_of("p_a"), 112);
		assert.deepEqual(T.items.find((it) => it.name === "status").coupling, ["f0", "f8"]);
		assert.equal(T.length, 160);
		assert.deepEqual(fragments.pair.map((it) => it.name), ["a", "b"]);
	});

	test("an omitted length follows the type, comments are kept", () => {
		const { T } = compile(SAMPLE).layouts;
		const item = (name) => T.items.find((it) => it.name === name);
		assert.equal(item("id").length, 16);
		assert.equal(item("f8").length, 1);
		assert.equal(item("b").length, 32);
		assert.equal(item("f8").comment, "high byte bit");
	});

	test("the compiled layout constructs data blocks", () => {
		const { T } = compile(SAMPLE).layouts;
		const data = new TData(T, "t");
		assert.equal(data.layout, T);
		assert.equal(data.id, 7);
		// status is composed from its bits, the bits of inline from the word
		assert.equal(data.status, 0x0001);
		assert.equal(data.i0, true);
		assert.equal(data.i8, false);
		assert.equal(data.p_b, 1.5);
		data.f8 = true;
		assert.equal(data.status, 0x0101);
	});

	test("tags_at_byte lists the tags of each byte, a word before its bits", () => {
		const { T } = compile(SAMPLE).layouts;
		const names = (byte) => T.tags_at_byte[byte].map((entry) => entry.name);
		assert.deepEqual(names(0), ["id"]);
		assert.deepEqual(names(2), ["status", "f8"]);
		assert.deepEqual(names(3), ["status", "f0"]);
		assert.deepEqual(names(8), ["b"]);
		assert.deepEqual(names(11), ["b"]);
	});

	test("an unknown fragment is reported", () => {
		const errors = errors_of("layouts:\n  T:\n    - { includes: nope, offset: 0 }\n");
		assert.deepEqual(errors, ["layout T: unknown fragment nope"]);
	});

	test("a circular fragment reference is reported", () => {
		const errors = errors_of(`
first:
  - { includes: second, offset: 0 }
second:
  - { includes: first, offset: 0 }
layouts:
  T:
    - { includes: first, offset: 0 }
`);
		assert.ok(errors.some((e) => e.includes("circular fragment reference first -> second -> first")), errors.join("\n"));
	});

	test("layout rule violations are reported all at once", () => {
		const errors = errors_of(`
layouts:
  T:
    - { name: a, type: Int, offset: 8, init_value: 0 }
    - { name: b, type: UInt, offset: 16, length: 8, init_value: 0 }
`);
		assert.ok(errors.includes("T.a: byte offset 1 is not even"), errors.join("\n"));
		assert.ok(errors.includes("T.b: length 8 does not match type UInt"), errors.join("\n"));
	});

	test("a file without the layouts key is rejected", () => {
		assert.deepEqual(errors_of("x: []\n"), ["the root key `layouts` must map layout names to item lists"]);
	});
});

describe("controller layouts", () => {
	test("NODE and COMMAND include the parameter block", () => {
		const first = node_parameters[0].name;
		assert.equal(NODE.items.find((it) => it.name === first).offset, 144);
		assert.equal(COMMAND.items.find((it) => it.name === first).offset, 160);
	});
});
