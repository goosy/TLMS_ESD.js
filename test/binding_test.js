import { create_fake_driver, make_struct, read_group, write_group } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { TData } from "../src/typed_data/TData.js";
import { Binding } from "../src/drivers/binding.js";

const GROUP_ITEMS = [
	{ name: "a", type: "UInt", offset: 0, length: 16, init_value: 0 },
	{
		name: "flags", type: "Word", offset: 16, length: 16, init_value: 0,
		is_combined: true, coupling: [
			{ name: "f0", type: "Bool", offset: 8, length: 1, init_value: false }, // byte 3
			{ name: "f8", type: "Bool", offset: 0, length: 1, init_value: false }, // byte 2
		],
	},
	{ name: "b", type: "UInt", offset: 32, length: 16, init_value: 0 },
	{ name: "c", type: "UDInt", offset: 64, length: 32, init_value: 0 },
	{ name: "d", type: "Int", offset: 96, length: 16, init_value: 0 },
];

const setup = (endian = "BE", options = {}, write_unit = 1) => {
	const data = new TData(make_struct(GROUP_ITEMS), "group");
	const driver = create_fake_driver(write_unit);
	const binding = new Binding(data, driver, { endian, ...options });
	return { data, driver, binding };
};

// The written areas show how the group merged its tags.
const areas_of = async (setup_args, names) => {
	const { driver, binding } = setup(...setup_args);
	const group = binding.create_group(...names);
	await write_group(group);
	return driver.writes.map(({ start, length, bytes }) => {
		assert.equal(length, bytes.length);
		return [start, length];
	});
};
// write unit 1 (S7) and 2 (Modbus TCP)
const written_areas = (...names) => areas_of(["BE", {}, 1], names);
const register_areas = (...names) => areas_of(["BE", {}, 2], names);

describe("Binding group areas", () => {
	test("separate tags give separate areas", async () => {
		assert.deepEqual(await written_areas("a", "b"), [[0, 2], [4, 2]]);
	});

	test("adjacent tags are merged", async () => {
		assert.deepEqual(await written_areas("a", "flags", "b"), [[0, 6]]);
	});

	test("areas are sorted regardless of add order", async () => {
		assert.deepEqual(await written_areas("d", "c", "a"), [[0, 2], [8, 6]]);
	});

	test("a tag bridging two areas merges them", async () => {
		assert.deepEqual(await written_areas("a", "b", "flags"), [[0, 6]]);
	});

	test("Bool tags form one-byte areas and merge with neighbours", async () => {
		assert.deepEqual(await written_areas("f0"), [[3, 1]]);
		assert.deepEqual(await written_areas("f0", "f8"), [[2, 2]]);
		assert.deepEqual(await written_areas("a", "f8"), [[0, 3]]);
	});

	test("Bool inside an existing area adds nothing", async () => {
		assert.deepEqual(await written_areas("flags", "f0", "f8"), [[2, 2]]);
	});

	test("a tag covering an existing Bool area is merged", async () => {
		assert.deepEqual(await written_areas("f0", "flags"), [[2, 2]]);
	});

	test("a tag may absorb several areas at once", async () => {
		assert.deepEqual(await written_areas("f0", "b", "a", "flags"), [[0, 6]]);
	});

	test("adding the same tag twice is ignored", async () => {
		assert.deepEqual(await written_areas("b", "b"), [[4, 2]]);
	});

	test("partially overlapping tags are merged (overlap is a layout error)", async () => {
		const items = [
			{ name: "x", type: "DInt", offset: 0, length: 32, init_value: 0 },
			{ name: "y", type: "DInt", offset: 16, length: 32, init_value: 0 },
		];
		const data = new TData(make_struct(items), "overlap");
		const driver = create_fake_driver();
		const binding = new Binding(data, driver, {});
		await write_group(binding.create_group("x", "y"));
		assert.deepEqual(driver.writes.map(({ start, length }) => [start, length]), [[0, 6]]);
	});

	test("unknown tag throws", () => {
		const { binding } = setup();
		assert.throws(() => binding.create_group("nope"), /no tag named nope/);
	});

	test("tag outside the IO area throws", () => {
		const { binding } = setup("BE", { start: 4 });
		assert.throws(() => binding.create_group("a"), /out of the IO exchange area/);
		const { binding: binding2 } = setup("BE", { length: 8 });
		assert.throws(() => binding2.create_group("c"), /out of the IO exchange area/);
	});
});

describe("Binding group write units", () => {
	test("Bool areas are expanded to whole registers", async () => {
		assert.deepEqual(await register_areas("f0"), [[2, 2]]);
		assert.deepEqual(await register_areas("f8"), [[2, 2]]);
		assert.deepEqual(await register_areas("a", "f0"), [[0, 4]]);
	});

	test("register-aligned tags are unchanged", async () => {
		assert.deepEqual(await register_areas("a", "b"), [[0, 2], [4, 2]]);
		assert.deepEqual(await register_areas("d", "c", "a"), [[0, 2], [8, 6]]);
	});

	test("expanded area uses the LE byte position of the Bool", async () => {
		const { data, driver, binding } = setup("LE", {}, 2);
		data.f0 = true;
		await write_group(binding.create_group("f0"));
		assert.deepEqual(driver.writes.map(({ start, bytes }) => [start, bytes]), [[2, [0x01, 0x00]]]);
	});

	test("unaligned IO area throws", () => {
		const data = new TData(make_struct(GROUP_ITEMS), "group");
		assert.throws(() => new Binding(data, create_fake_driver(2), { start: 1, length: 4 }), /not aligned/);
		assert.throws(() => new Binding(data, create_fake_driver(2), { remote_start: 3 }), /not aligned/);
		assert.throws(() => new Binding(data, create_fake_driver(2), { length: 5 }), /not aligned/);
	});

	test("odd IO area is accepted with write unit 1", () => {
		const data = new TData(make_struct(GROUP_ITEMS), "group");
		assert.doesNotThrow(() => new Binding(data, create_fake_driver(1), { start: 3, remote_start: 7, length: 5 }));
	});
});

describe("Binding group read/write", () => {
	test("write converts with the group endian and writes each area", async () => {
		const { data, driver, binding } = setup("LE");
		data.b = 0x1234;
		data.c = 0x01020304;
		const group = binding.create_group("b", "c");
		assert.equal(await write_group(group), true);
		assert.deepEqual(driver.writes.map(({ start, bytes }) => [start, bytes]), [
			[4, [0x34, 0x12]],
			[8, [0x04, 0x03, 0x02, 0x01]],
		]);
	});

	test("write uses the remote offset", async () => {
		const { data, driver, binding } = setup("BE", { remote_start: 40, start: 2 });
		data.b = 1;
		await write_group(binding.create_group("b"));
		assert.equal(driver.writes[0].start, 42);
	});

	test("write returns false if any area fails but still writes all areas", async () => {
		const { driver, binding } = setup();
		driver.write_results = [false, true];
		assert.equal(await write_group(binding.create_group("a", "b")), false);
		assert.equal(driver.writes.length, 2);
	});

	test("read updates only the group tags and emits change", async () => {
		const { data, driver, binding } = setup("LE");
		driver.remote.set([0x01, 0x00], 0); // a
		driver.remote.set([0x34, 0x12], 4); // b
		const events = [];
		data.on("change", (name, old_value, new_value) => events.push([name, old_value, new_value]));
		assert.equal(await read_group(binding.create_group("b")), true);
		assert.equal(data.b, 0x1234);
		assert.equal(data.a, 0);
		assert.deepEqual(events, [["b", 0, 0x1234]]);
	});

	test("read returns false and keeps values when the driver read fails", async () => {
		const { data, driver, binding } = setup();
		driver.remote.set([0x00, 0x05], 4);
		driver.read_result = null;
		assert.equal(await read_group(binding.create_group("b")), false);
		assert.equal(data.b, 0);
	});

	test("read of a word updates its coupled bits", async () => {
		const { data, driver, binding } = setup();
		driver.remote.set([0x00, 0x01], 2);
		await read_group(binding.create_group("flags"));
		assert.equal(data.flags, 1);
		assert.equal(data.f0, true);
	});

	for (const endian of ["LE", "BEBS"]) {
		test(`Bool read follows the ${endian} byte order`, async () => {
			const { data, driver, binding } = setup(endian);
			driver.remote.set([0x01, 0x00], 2); // flags = 0x0001 in device byte order
			await read_group(binding.create_group("f0"));
			assert.equal(data.f0, true);
		});

		test(`Bool write follows the ${endian} byte order`, async () => {
			const { data, driver, binding } = setup(endian);
			data.f0 = true;
			await write_group(binding.create_group("f0", "f8"));
			assert.deepEqual([...driver.remote.subarray(2, 4)], [0x01, 0x00]);
		});
	}
});
