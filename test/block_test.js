import { controller_layouts } from "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { Ldata } from "modbus-emulator";

const { LINE, SECTION, NODE, COMMAND, RECORD } = controller_layouts();

const is_arr_equal = (arr1, arr2) => {
	return arr1.length === arr2.length
		&& arr1.every((item, index) => item === arr2[index]);
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
	"comm_OK", "work_OK",
	"pump_run", "pump_change_F",
	"pump_run_1", "pump_run_2", "pump_run_3", "pump_run_4",
	"pressure_enabled", "temperature_enabled", "pressure_SD_F",
	"delay_protect",
	"pressure_AH_F", "pressure_WH_F",
	"pressure_WL_F", "pressure_AL_F",
];

test("NODE", () => {
	assert.strictEqual(NODE.length, 1168);
	assert.ok(is_arr_equal(NODE.items[1].coupling, node_status));
	assert.strictEqual(NODE.items[17].offset, 23);
	assert.ok(is_arr_equal(NODE.items[21].coupling, commands_list));
	assert.strictEqual(NODE.items[37].offset, 135);
	assert.strictEqual(NODE.items[38 + 35].offset, 144 + 992);
});

test("COMMAND", () => {
	assert.strictEqual(COMMAND.length, 1184);
	assert.ok(is_arr_equal(COMMAND.items[6].coupling, commands_list));
	assert.strictEqual(COMMAND.items[22].offset, 151);
	assert.strictEqual(COMMAND.items[23 + 35].offset, 160 + 992);
});

describe("controller data blocks", () => {
	const structs = { LINE, SECTION, NODE, COMMAND, RECORD };
	for (const [struct_name, struct] of Object.entries(structs)) {
		test(`${struct_name}: every tag keeps its init_value after construction`, () => {
			const data = new Ldata(struct_name, struct_name);
			for (const item of struct.items) {
				const expected = item.type === "Real" ? Math.fround(item.init_value) : item.init_value;
				assert.equal(data[item.name], expected, `${struct_name}.${item.name}`);
			}
		});
	}
});
