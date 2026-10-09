import { make_struct } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { LINE, SECTION, NODE, COMMAND, RECORD } from "../src/layouts.js";
import { validate_structure } from "../src/typed_data/structure.js";

const VALID_ITEMS = [
	{ name: "id", type: "UInt", offset: 0, length: 16, init_value: 0 },
	{
		name: "status", type: "Word", offset: 16, length: 16,
		is_combined: true, coupling: [
			{ name: "bit_0", type: "Bool", offset: 8, length: 1, init_value: false },
			{ name: "bit_8", type: "Bool", offset: 0, length: 1, init_value: false },
		],
	},
	{ name: "free_bit", type: "Bool", offset: 32, length: 1, init_value: false },
	{ name: "small", type: "SInt", offset: 40, length: 8, init_value: -1 },
	{ name: "value", type: "Real", offset: 48, length: 32, init_value: 1.5 },
];

const errors_of = (items) => validate_structure(make_struct(items, "T"));

// asserts that exactly one error mentions every fragment
const assert_error = (items, ...fragments) => {
	const errors = errors_of(items);
	assert.equal(errors.length, 1, JSON.stringify(errors));
	for (const fragment of fragments) assert.ok(errors[0].includes(fragment), errors[0]);
};

describe("layout validation", () => {
	for (const struct of [LINE, SECTION, NODE, COMMAND, RECORD]) {
		test(`${struct.name} is valid`, () => {
			assert.deepEqual(validate_structure(struct), []);
		});
	}

	test("a valid sample has no errors", () => {
		assert.deepEqual(errors_of(VALID_ITEMS), []);
	});

	test("duplicated names are reported", () => {
		assert_error([
			{ name: "a", type: "UInt", offset: 0, length: 16, init_value: 0 },
			{ name: "a", type: "UInt", offset: 16, length: 16, init_value: 0 },
		], "T.a", "duplicated name");
	});

	for (const name of ["get", "name", "on", "size"]) {
		test(`name ${name} colliding with a TData member is reported`, () => {
			assert_error([{ name, type: "UInt", offset: 0, length: 16, init_value: 0 }], "collides");
		});
	}

	test("unknown type is reported", () => {
		assert_error([{ name: "a", type: "LReal", offset: 0, length: 16, init_value: 0 }], "unknown type");
	});

	test("length not matching the type is reported", () => {
		assert_error([{ name: "a", type: "Int", offset: 0, length: 32, init_value: 0 }], "length 32");
	});

	test("non-Bool off a byte boundary is reported", () => {
		assert_error([
			{ name: "a", type: "Byte", offset: 4, length: 8, init_value: 0 },
			{ name: "pad", type: "Byte", offset: 24, length: 8, init_value: 0 },
		], "T.a", "byte boundary");
	});

	test("multi-byte tag at an odd byte is reported", () => {
		assert_error([
			{ name: "a", type: "Int", offset: 8, length: 16, init_value: 0 },
			{ name: "pad", type: "Byte", offset: 24, length: 8, init_value: 0 },
		], "T.a", "not even");
	});

	test("single-byte tags at an odd byte are valid", () => {
		assert.deepEqual(errors_of([
			{ name: "a", type: "Byte", offset: 8, length: 8, init_value: 0 },
			{ name: "b", type: "USInt", offset: 0, length: 8, init_value: 0 },
		]), []);
	});

	// [type, bit length, invalid init_value]; padded to one register below
	const init_cases = [
		["Bool", 1, 1],
		["SInt", 8, 128],
		["Int", 16, 32768],
		["Int", 16, 1.5],
		["UDInt", 32, -1],
		["Real", 32, Number.NaN],
		["Real", 32, "0"],
	];
	for (const [type, length, init_value] of init_cases) {
		test(`init_value ${String(init_value)} for ${type} is reported`, () => {
			const items = [{ name: "a", type, offset: 0, length, init_value }];
			if (length < 16) items.push({ name: "pad", type: "Byte", offset: 8, length: 8, init_value: 0 });
			assert_error(items, "init_value");
		});
	}

	test("overlapping non-Bool tags are reported", () => {
		assert_error([
			{ name: "a", type: "DInt", offset: 0, length: 32, init_value: 0 },
			{ name: "b", type: "Int", offset: 16, length: 16, init_value: 0 },
		], "T.b", "overlaps a");
	});

	test("overlap is found past a short tag nested in the scan", () => {
		const errors = errors_of([
			{ name: "a", type: "DInt", offset: 0, length: 32, init_value: 0 },
			{ name: "b", type: "Int", offset: 0, length: 16, init_value: 0 },
			{ name: "c", type: "Int", offset: 16, length: 16, init_value: 0 },
		]);
		assert.equal(errors.length, 2, JSON.stringify(errors));
		assert.ok(errors.some((e) => e.startsWith("T.c") && e.includes("overlaps a")), JSON.stringify(errors));
	});

	test("two Bools on the same bit are reported", () => {
		assert_error([
			{ name: "a", type: "Bool", offset: 3, length: 1, init_value: false },
			{ name: "b", type: "Bool", offset: 3, length: 1, init_value: false },
			{ name: "pad", type: "Byte", offset: 8, length: 8, init_value: 0 },
		], "T.b", "shares bit 3 with a");
	});

	test("Bool inside a non-Bool tag that does not couple it is reported", () => {
		assert_error([
			{ name: "a", type: "UInt", offset: 0, length: 16, init_value: 0 },
			{ name: "b", type: "Bool", offset: 9, length: 1, init_value: false },
		], "T.b", "inside a");
	});

	test("coupled bit outside its word is reported", () => {
		assert_error([
			{
				name: "w", type: "Word", offset: 0, length: 16,
				is_combined: true, coupling: [
					{ name: "b", type: "Bool", offset: 16, length: 1, init_value: false },
				],
			},
			{ name: "pad", type: "Byte", offset: 24, length: 8, init_value: 0 },
		], "T.w", "outside");
	});

	test("init_value on both a word and its bits is reported", () => {
		assert_error([
			{
				name: "w", type: "Word", offset: 0, length: 16, init_value: 0,
				is_combined: true, coupling: [
					{ name: "b0", type: "Bool", offset: 8, length: 1, init_value: true },
					{ name: "b1", type: "Bool", offset: 9, length: 1 },
				],
			},
		], "T.w", "both on the word and on its bits b0");
	});

	test("a word without init_value is composed from its bits", () => {
		const struct = make_struct([
			{
				name: "w", type: "Word", offset: 0, length: 16,
				is_combined: true, coupling: [
					{ name: "b0", type: "Bool", offset: 8, length: 1, init_value: true },
					{ name: "b11", type: "Bool", offset: 3, length: 1, init_value: true },
					{ name: "b1", type: "Bool", offset: 9, length: 1 },
				],
			},
		], "T");
		const init = (name) => struct.items.find((it) => it.name === name).init_value;
		assert.equal(init("w"), 0x0801);
		assert.equal(init("b1"), false);
		assert.deepEqual(validate_structure(struct), []);
	});

	test("bits without init_value take theirs from the word", () => {
		const struct = make_struct([
			{
				name: "w", type: "Word", offset: 0, length: 16, init_value: 0x0801,
				is_combined: true, coupling: [
					{ name: "b0", type: "Bool", offset: 8, length: 1 },
					{ name: "b11", type: "Bool", offset: 3, length: 1 },
					{ name: "b1", type: "Bool", offset: 9, length: 1 },
				],
			},
		], "T");
		const init = (name) => struct.items.find((it) => it.name === name).init_value;
		assert.equal(init("b0"), true);
		assert.equal(init("b11"), true);
		assert.equal(init("b1"), false);
		assert.deepEqual(validate_structure(struct), []);
	});

	test("length that is not whole registers is reported", () => {
		assert_error([{ name: "a", type: "Byte", offset: 0, length: 8, init_value: 0 }], "whole number of registers");
	});

	test("all violations are reported, not only the first", () => {
		const errors = errors_of([
			{ name: "a", type: "Int", offset: 8, length: 16, init_value: 0 },
			{ name: "a", type: "Int", offset: 32, length: 32, init_value: 0 },
		]);
		assert.ok(errors.length >= 3, JSON.stringify(errors));
	});
});
