import { assert_exits, assert_exits_async, create_fake_driver, make_struct } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test, { describe } from 'node:test';
import { NODE } from "../src/structs/node.js";
import { COMMAND } from "../src/structs/command.js";
import { LINE } from "../src/structs/line.js";
import { SECTION } from "../src/structs/section.js";
import { RECORD } from "../src/structs/record.js";
import { TData } from "../src/typed_data/TData.js";

const is_arr_equal = (arr1, arr2) => {
    return arr1.length === arr2.length &&
        arr1.every((item, index) => item === arr2[index]);
};

const commands_list = [
    "stop_pumps", "cancel_stop",
    "horn", "reset_horn",
    "enable_pressure_SD", "disable_pressure_SD",
    "read_paras", "write_paras",
    "enable_pressure_alarm", "disable_pressure_alarm",
    "enable", "disable",
    "reset_CPU",
    "reset_conn", "reserve",
    "executing",
];

const node_status = [
    'comm_OK', 'work_OK',
    'pump_run', 'pump_change_F',
    'pump_run_1', 'pump_run_2', 'pump_run_3', 'pump_run_4',
    'pressure_enabled', 'temperature_enabled', 'pressure_SD_F',
    'delay_protect',
    'pressure_AH_F', 'pressure_WH_F',
    'pressure_WL_F', 'pressure_AL_F'
];

test('NODE', () => {
    assert.strictEqual(NODE.length, 1168);
    assert.ok(is_arr_equal(NODE.items[1].coupling, node_status));
    assert.strictEqual(NODE.items[17].offset, 23);
    assert.ok(is_arr_equal(NODE.items[21].coupling, commands_list));
    assert.strictEqual(NODE.items[37].offset, 135);
    assert.strictEqual(NODE.items[38 + 35].offset, 144 + 992);
});

test('COMMAND', () => {
    assert.strictEqual(COMMAND.length, 1184);
    assert.ok(is_arr_equal(COMMAND.items[6].coupling, commands_list));
    assert.strictEqual(COMMAND.items[22].offset, 151);
    assert.strictEqual(COMMAND.items[23 + 35].offset, 160 + 992);
});

// "status" bit order: coupling offset 8 is word bit 0, offset 0 is word bit 8.
const SAMPLE_ITEMS = [
    { name: "id", type: "UInt", offset: 0, length: 16, init_value: 7 },
    {
        name: "status", type: "Word", offset: 16, length: 16, init_value: 0x0101,
        is_combined: true, coupling: [
            { name: "bit_0", type: "Bool", offset: 8, length: 1, init_value: true },
            { name: "bit_1", type: "Bool", offset: 9, length: 1, init_value: false },
            { name: "bit_8", type: "Bool", offset: 0, length: 1, init_value: true },
        ],
    },
    { name: "value", type: "Real", offset: 32, length: 32, init_value: 1.5 },
    { name: "count", type: "DInt", offset: 64, length: 32, init_value: -1 },
];

const create_sample = () => new TData(make_struct(SAMPLE_ITEMS), "sample");

describe("TData layout", () => {
    test("buffer size is the struct bit length / 8", () => {
        const data = create_sample();
        assert.equal(data.size, 12);
        assert.equal(data.buffer.length, 12);
        assert.equal(data.IO_buffer.length, 12);
        assert.notEqual(data.IO_buffer, data.buffer);
    });

    test("buffer holds init values in big-endian order", () => {
        const data = create_sample();
        assert.deepEqual([...data.buffer], [
            0x00, 0x07,
            0x01, 0x01,
            0x3f, 0xc0, 0x00, 0x00,
            0xff, 0xff, 0xff, 0xff,
        ]);
    });

    test("every tag is an enumerable, non-configurable property", () => {
        const data = create_sample();
        for (const name of ["id", "status", "bit_0", "bit_1", "bit_8", "value", "count"]) {
            const desc = Object.getOwnPropertyDescriptor(data, name);
            assert.ok(desc, name);
            assert.equal(desc.enumerable, true);
            assert.equal(desc.configurable, false);
        }
        assert.throws(() => Object.defineProperty(data, "id", { value: 1 }), TypeError);
    });

    test("get() returns the TTag, undefined for unknown names", () => {
        const data = create_sample();
        assert.equal(data.get("count").value, -1);
        assert.equal(data.get("count").name, "count");
        assert.equal(data.get("nope"), undefined);
    });

    test("tag name colliding with a TData member exits", (t) => {
        const items = [{ name: "get", type: "UInt", offset: 0, length: 16, init_value: 0 }];
        assert_exits(t, () => new TData(make_struct(items), "bad"));
    });

    test("tag name colliding with a later-assigned member is rejected", (t) => {
        const items = [{ name: "driver", type: "UInt", offset: 0, length: 16, init_value: 0 }];
        assert_exits(t, () => new TData(make_struct(items), "bad"));
    });
});

describe("TData change event", () => {
    test("property write emits (name, old, new) after the value is applied", () => {
        const data = create_sample();
        const events = [];
        data.on("change", (name, old_value, new_value) => {
            events.push([name, old_value, new_value, data[name]]);
        });
        data.count = 5;
        data.count = 5;
        assert.deepEqual(events, [["count", -1, 5, 5]]);
    });

    test("check_all_tags reports direct buffer writes (server path)", () => {
        const data = create_sample();
        const events = [];
        data.on("change", (name, old_value, new_value) => events.push([name, old_value, new_value]));
        data.buffer.writeUInt16BE(0x0002, 2);
        data.buffer.writeUInt16BE(9, 0);
        data.check_all_tags();
        assert.deepEqual(events.sort(), [
            ["bit_0", true, false],
            ["bit_1", false, true],
            ["bit_8", true, false],
            ["id", 7, 9],
            ["status", 0x0101, 0x0002],
        ]);
    });

    test("check_tag accepts a tag or a tag name", () => {
        const data = create_sample();
        let count = 0;
        data.on("change", () => count++);
        data.buffer.writeUInt16BE(1, 0);
        data.check_tag("id");
        data.buffer.writeUInt16BE(2, 0);
        data.check_tag(data.get("id"));
        assert.equal(count, 2);
    });

    test("check_tag ignores unknown tag names", () => {
        const data = create_sample();
        assert.doesNotThrow(() => data.check_tag("nope"));
    });
});

describe("TData combined word", () => {
    test("writing the word updates the bits", () => {
        const data = create_sample();
        const events = [];
        data.on("change", (name) => events.push(name));
        data.status = 0x0002;
        assert.equal(data.bit_0, false);
        assert.equal(data.bit_1, true);
        assert.equal(data.bit_8, false);
        assert.deepEqual(events.sort(), ["bit_0", "bit_1", "bit_8", "status"]);
    });

    test("writing a bit updates the word", () => {
        const data = create_sample();
        const events = [];
        data.on("change", (name, old_value, new_value) => events.push([name, old_value, new_value]));
        data.bit_1 = true;
        assert.equal(data.status, 0x0103);
        assert.deepEqual(events, [["bit_1", false, true], ["status", 0x0101, 0x0103]]);
    });

    test("coupling offset 8..15 is the low byte, 0..7 the high byte", () => {
        const data = create_sample();
        data.status = 0;
        data.bit_8 = true;
        assert.equal(data.status, 0x0100);
        assert.deepEqual([...data.buffer.subarray(2, 4)], [0x01, 0x00]);
    });

    const structs = { LINE, SECTION, NODE, COMMAND, RECORD };
    for (const [struct_name, struct] of Object.entries(structs)) {
        test(`${struct_name}: every tag keeps its init_value after construction`, () => {
            const data = new TData(struct, struct_name);
            for (const item of struct.items) {
                const expected = item.type === "Real" ? Math.fround(item.init_value) : item.init_value;
                assert.equal(data[item.name], expected, `${struct_name}.${item.name}`);
            }
        });
    }
});

describe("TData set_IO", () => {
    const setup = () => {
        const data = create_sample();
        const driver = create_fake_driver();
        // TData bytes [2, 10) map to remote bytes [100, 108)
        data.set_IO(driver, { remote_start: 100, start: 2, length: 8, endian: "LE" }, "extra");
        return { data, driver };
    };

    test("IO_read_all reads the whole exchange area into IO_buffer", async () => {
        const { data, driver } = setup();
        for (let i = 0; i < 8; i++) driver.remote[100 + i] = i + 1;
        let emitted = null;
        data.on("data", (buffer) => { emitted = buffer; });
        assert.equal(await data.IO_read_all(), true);
        assert.deepEqual(driver.reads, [{ start: 100, length: 8, extras: ["extra"] }]);
        assert.deepEqual([...data.IO_buffer], [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0]);
        assert.deepEqual([...emitted], [1, 2, 3, 4, 5, 6, 7, 8]);
        // IO does not touch the internal buffer or the tag values
        assert.equal(data.id, 7);
        assert.equal(data.count, -1);
    });

    test("IO_read reads a sub-range at the mapped remote address", async () => {
        const { data, driver } = setup();
        driver.remote[102] = 0xab;
        driver.remote[103] = 0xcd;
        assert.equal(await data.IO_read({ start: 4, length: 2 }), true);
        assert.deepEqual(driver.reads, [{ start: 102, length: 2, extras: ["extra"] }]);
        assert.deepEqual([...data.IO_buffer.subarray(4, 6)], [0xab, 0xcd]);
    });

    test("IO_write writes at the mapped remote address", async () => {
        const { data, driver } = setup();
        assert.equal(await data.IO_write(Buffer.from([1, 2]), { start: 8, length: 2 }), true);
        assert.deepEqual(driver.writes, [{ start: 106, bytes: [1, 2], extras: ["extra"] }]);
    });

    test("range outside the exchange area exits", async (t) => {
        const { data } = setup();
        await assert_exits_async(t, () => data.IO_read({ start: 0, length: 2 }));
        await assert_exits_async(t, () => data.IO_read({ start: 8, length: 4 }));
        await assert_exits_async(t, () => data.IO_write(Buffer.alloc(2), { start: 10, length: 2 }));
    });

    test("returns false when the driver is not connected", async (t) => {
        t.mock.method(console, "error", () => { });
        const { data, driver } = setup();
        driver.is_connected = false;
        assert.equal(await data.IO_read_all(), false);
        assert.equal(await data.IO_read({ start: 2, length: 2 }), false);
        assert.equal(await data.IO_write(Buffer.alloc(2), { start: 2, length: 2 }), false);
        assert.equal(driver.reads.length + driver.writes.length, 0);
    });

    test("returns false when the driver read fails", async () => {
        const { data, driver } = setup();
        driver.read_result = null;
        assert.equal(await data.IO_read_all(), false);
        assert.equal(await data.IO_read({ start: 2, length: 2 }), false);
    });

    test("defaults: start 0, remote_start 0, length to the end, endian BE", async () => {
        const data = create_sample();
        const driver = create_fake_driver();
        data.set_IO(driver, {});
        await data.IO_read_all();
        assert.deepEqual(driver.reads[0], { start: 0, length: 12, extras: [] });
        assert.equal(data.create_tag_group("id").endian, "BE");
    });

    test("set_IO(null) clears the IO functions", () => {
        const { data } = setup();
        data.set_IO(null);
        assert.equal(data.driver, null);
        assert.equal(data.IO_read, null);
        assert.equal(data.IO_write, null);
    });
});
