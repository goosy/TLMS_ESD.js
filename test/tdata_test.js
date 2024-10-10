import assert from 'node:assert/strict';
import test from 'node:test';
import { NODE } from "../src/structs/node.js";
import { COMMAND } from "../src/structs/command.js";
// import { LINE } from "../src/structs/line.js";
// import { SECTION } from "../src/structs/section.js";
// import { RECORD } from "../src/structs/record.js";

const isArrEqual = (arr1, arr2) => {
    return arr1.length === arr2.length &&
        arr1.every((item, index) => item === arr2[index]);
};

test('NODE', () => {
    assert.strictEqual(NODE.length, 1168);
    assert.ok(isArrEqual(NODE.items[1].coupling, [
        'comm_OK', 'work_OK',
        'pump_run', 'pump_change_F',
        'pump_run_1', 'pump_run_2', 'pump_run_3', 'pump_run_4',
        'pressure_enabled', 'temperature_enabled', 'pressure_SD_F',
        'delay_protect',
        'pressure_AH_F', 'pressure_WH_F',
        'pressure_WL_F', 'pressure_AL_F'
    ]));
    assert.strictEqual(NODE.items[17].offset, 31);
    assert.ok(isArrEqual(NODE.items[21].coupling, [
        "stop_pumps", "cancel_stop",
        "horn", "reset_horn",
        "enable_pressure_SD", "disable_pressure_SD",
        "read_paras", "write_paras",
        "enable_pressure_alarm", "disable_pressure_alarm",
        "enable", "disable",
        "reset_CPU",
        "reset_conn",
        "executing",
    ]));
    assert.strictEqual(NODE.items[36].offset, 143);
    assert.strictEqual(NODE.items[37 + 35].offset, 144 + 992);
});

test('COMMAND', () => {
    assert.strictEqual(COMMAND.length, 1184);
    assert.ok(isArrEqual(COMMAND.items[6].coupling, [
        "stop_pumps", "cancel_stop",
        "horn", "reset_horn",
        "enable_pressure_SD", "disable_pressure_SD",
        "read_paras", "write_paras",
        "enable_pressure_alarm", "disable_pressure_alarm",
        "enable", "disable",
        "reset_CPU",
        "reset_conn",
        "executing",
    ]));
    assert.strictEqual(COMMAND.items[21].offset, 159);
    assert.strictEqual(COMMAND.items[22 + 35].offset, 160 + 992);
});
