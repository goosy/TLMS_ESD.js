import { assert_exits, create_fake_driver, make_struct, mock_exit } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { TData } from "../src/typed_data/TData.js";

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

const setup = (endian = "BE", options = {}) => {
    const data = new TData(make_struct(GROUP_ITEMS), "group");
    const driver = create_fake_driver();
    data.set_IO(driver, { endian, ...options });
    return { data, driver };
};

// The written areas show how the group merged its tags.
const written_areas = async (...names) => {
    const { data, driver } = setup();
    const group = data.create_tag_group(...names);
    await group.write();
    return driver.writes.map(({ start, bytes }) => [start, bytes.length]);
};

describe("TGroup areas", () => {
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

    test("a tag covering an existing Bool area is merged", {
        todo: "adding a word after one of its bits is treated as an overlap and exits",
    }, async (t) => {
        mock_exit(t);
        assert.deepEqual(await written_areas("f0", "flags"), [[2, 2]]);
    });

    test("unknown tag exits", (t) => {
        const { data } = setup();
        assert_exits(t, () => data.create_tag_group("nope"));
    });

    test("tag outside the IO area exits", (t) => {
        const { data } = setup("BE", { start: 4 });
        assert_exits(t, () => data.create_tag_group("a"));
        const { data: data2 } = setup("BE", { length: 8 });
        assert_exits(t, () => data2.create_tag_group("c"));
    });

    test("partially overlapping tags exit", (t) => {
        const items = [
            { name: "x", type: "DInt", offset: 0, length: 32, init_value: 0 },
            { name: "y", type: "DInt", offset: 16, length: 32, init_value: 0 },
        ];
        const data = new TData(make_struct(items), "overlap");
        data.set_IO(create_fake_driver(), {});
        assert_exits(t, () => data.create_tag_group("x", "y"));
    });
});

describe("TGroup read/write", () => {
    test("write converts with the group endian and writes each area", async () => {
        const { data, driver } = setup("LE");
        data.b = 0x1234;
        data.c = 0x01020304;
        const group = data.create_tag_group("b", "c");
        assert.equal(await group.write(), true);
        assert.deepEqual(driver.writes.map(({ start, bytes }) => [start, bytes]), [
            [4, [0x34, 0x12]],
            [8, [0x04, 0x03, 0x02, 0x01]],
        ]);
    });

    test("write uses the remote offset", async () => {
        const { data, driver } = setup("BE", { remote_start: 40, start: 2 });
        data.b = 1;
        await data.create_tag_group("b").write();
        assert.equal(driver.writes[0].start, 42);
    });

    test("write returns false if any area fails but still writes all areas", async () => {
        const { data, driver } = setup();
        driver.write_results = [false, true];
        assert.equal(await data.create_tag_group("a", "b").write(), false);
        assert.equal(driver.writes.length, 2);
    });

    test("read updates only the group tags and emits change", async () => {
        const { data, driver } = setup("LE");
        driver.remote.set([0x01, 0x00], 0); // a
        driver.remote.set([0x34, 0x12], 4); // b
        const events = [];
        data.on("change", (name, old_value, new_value) => events.push([name, old_value, new_value]));
        assert.equal(await data.create_tag_group("b").read(), true);
        assert.equal(data.b, 0x1234);
        assert.equal(data.a, 0);
        assert.deepEqual(events, [["b", 0, 0x1234]]);
    });

    test("read returns false and keeps values when the driver read fails", async () => {
        const { data, driver } = setup();
        driver.remote.set([0x00, 0x05], 4);
        driver.read_result = null;
        assert.equal(await data.create_tag_group("b").read(), false);
        assert.equal(data.b, 0);
    });

    test("read of a word updates its coupled bits", async () => {
        const { data, driver } = setup();
        driver.remote.set([0x00, 0x01], 2);
        await data.create_tag_group("flags").read();
        assert.equal(data.flags, 1);
        assert.equal(data.f0, true);
    });

    for (const endian of ["LE", "BEBS"]) {
        test(`Bool read follows the ${endian} byte order`, { todo: "Bool read_from ignores endian" }, async () => {
            const { data, driver } = setup(endian);
            driver.remote.set([0x01, 0x00], 2); // flags = 0x0001 in device byte order
            await data.create_tag_group("f0").read();
            assert.equal(data.f0, true);
        });

        test(`Bool write follows the ${endian} byte order`, { todo: "Bool write_to ignores endian" }, async () => {
            const { data, driver } = setup(endian);
            data.f0 = true;
            await data.create_tag_group("f0", "f8").write();
            assert.deepEqual([...driver.remote.subarray(2, 4)], [0x01, 0x00]);
        });
    }
});

describe("TGroup copy_from", () => {
    test("copies tags by name and skips missing ones", () => {
        const { data } = setup();
        const group = data.create_tag_group("a", "b");
        group.copy_from({ a: 3 });
        assert.equal(data.a, 3);
        assert.equal(data.b, 0);
    });

    test("copies from another TData", () => {
        const { data } = setup();
        const { data: source } = setup();
        source.b = 9;
        source.c = 10;
        data.create_tag_group("b").copy_from(source);
        assert.equal(data.b, 9);
        assert.equal(data.c, 0);
    });

    test("copying a word updates its coupled bits", () => {
        const { data } = setup();
        data.create_tag_group("flags").copy_from({ flags: 0x0100 });
        assert.equal(data.flags, 0x0100);
        assert.equal(data.f8, true);
    });
});
