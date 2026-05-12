import assert from 'node:assert/strict';
import test from 'node:test';
import { NODE } from "../src/structs/node.js";
import { COMMAND } from "../src/structs/command.js";
// import { LINE } from "../src/structs/line.js";
// import { SECTION } from "../src/structs/section.js";
// import { RECORD } from "../src/structs/record.js";

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
