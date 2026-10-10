// Behavior baseline of the controller as a whole (doc/plan-scan.md step 0).
// Inputs are set only through the actuator memory, the HMI (upward server
// vector) and driver events; outputs are read from the data blocks and the
// actuator command areas. See test/harness.js and test/fixtures/system/.
import { create_system, MAIN_PERIOD } from "./harness.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import test, { describe } from "node:test";

// node parameter delay_protect_time (NODE init_value)
const DELAY_PROTECT_TIME = 5000;
// fixture: flow_diff_*_delay 1000 ms, action_time 3000 ms
const FLOW_ALARM_TIME = 2500;
const ACTION_TIME = 3000;

function run_pump(sys, on) {
	sys.device("A").set("pump_run_1", on);
}

function set_flows(sys, flows) {
	for (const [name, value] of Object.entries(flows)) sys.device(name).set("flowmeter", value);
}

/** The commands word value with only the given command bit set. */
function command_bit(sys, node, name) {
	const command = sys.node(node).command;
	const saved = command.commands;
	command.commands = 0;
	command[name] = true;
	const value = command.commands;
	command.commands = saved;
	return value;
}

describe("actuator", () => {
	test("pump_run follows the pumps reported by the actuator", async (t) => {
		const sys = await create_system(t);
		sys.device("A").set("pump_run_2", true);
		await sys.settle();
		assert.equal(sys.node("A").data.pump_run, true);
		assert.equal(sys.section("S1").data.pump_run, true);
		assert.equal(sys.section("S2").data.pump_run, false);
		assert.equal(sys.line("L1").data.pump_run, true);

		sys.device("A").set("pump_run_2", false);
		await sys.settle();
		assert.equal(sys.node("A").data.pump_run, false);
		assert.equal(sys.section("S1").data.pump_run, false);
		assert.equal(sys.line("L1").data.pump_run, false);
	});

	test("measurements are read in every device byte order", async (t) => {
		const sys = await create_system(t);
		set_flows(sys, { A: 100, B: 70, C: 50, D: 45.5 });
		sys.device("D").set("pressure", 1.25);
		await sys.settle();
		assert.equal(sys.node("C").data.ID, 103);
		assert.equal(sys.node("D").data.ID, 104);
		assert.equal(sys.node("D").data.pressure, 1.25);
		assert.equal(sys.section("S1").data.flow_begin, 100);
		assert.equal(sys.section("S1").data.flow_end, 70);
		assert.equal(sys.section("S1").data.flow_diff, 30);
		assert.equal(sys.section("S2").data.flow_diff, 4.5);
		assert.equal(sys.hmi.get("S2", "flow_diff"), 4.5);
	});

	test("an HMI command is sent with the node ID and cleared by the response", async (t) => {
		const sys = await create_system(t);
		const { command } = sys.node("A");
		sys.hmi.set("A", "enable_pressure_SD", true, "command");
		assert.equal(command.enable_pressure_SD, true);
		await sys.settle();
		assert.equal(sys.device("A").command("enable_pressure_SD"), true);
		assert.equal(sys.device("A").command("ID"), 101);

		sys.device("A").set("response_code", command_bit(sys, "A", "enable_pressure_SD"));
		await sys.settle();
		assert.equal(command.enable_pressure_SD, false);
		assert.equal(command.executing, false);
		assert.equal(sys.device("A").command("enable_pressure_SD"), false);
	});

	test("pressure_SD_F reported by the actuator clears the enable command", async (t) => {
		const sys = await create_system(t);
		sys.hmi.set("A", "enable_pressure_SD", true, "command");
		await sys.settle();
		sys.device("A").set("pressure_SD_F", true);
		await sys.settle();
		assert.equal(sys.node("A").command.enable_pressure_SD, false);
		assert.equal(sys.device("A").command("enable_pressure_SD"), false);
	});

	test("an unanswered command is sent again", {
		todo: "no_response_count in node_proc.js is shared by all actuators and reset by the ones without commands",
	}, async (t) => {
		const sys = await create_system(t);
		sys.hmi.set("A", "enable_pressure_SD", true, "command");
		await sys.settle();
		const sent = sys.device("A").command_writes().length;
		assert.ok(sent >= 1);
		await sys.advance(6 * MAIN_PERIOD);
		assert.ok(sys.device("A").command_writes().length > sent);
	});

	test("an unsupported command bit is cleared", async (t) => {
		const sys = await create_system(t);
		sys.hmi.set("A", "horn", true, "command");
		await sys.advance(2 * MAIN_PERIOD);
		assert.equal(sys.node("A").command.horn, false);
	});

	test("read_paras copies the actuator parameters into the command block", async (t) => {
		const sys = await create_system(t);
		sys.device("A").set("pressure_AH", 1.5);
		await sys.settle();
		assert.equal(sys.node("A").data.pressure_AH, 1.5);
		assert.equal(sys.node("A").command.pressure_AH, 0);

		sys.hmi.set("A", "read_paras", true, "command");
		await sys.settle();
		assert.equal(sys.node("A").command.pressure_AH, 1.5);
		assert.equal(sys.node("A").command.read_paras, false);
	});

	test("write_paras writes the command parameters to the actuator", async (t) => {
		const sys = await create_system(t);
		sys.hmi.set("A", "pressure_AH", 2.5, "command");
		sys.hmi.set("A", "write_paras", true, "command");
		await sys.settle();
		assert.equal(sys.device("A").get("pressure_AH"), 2.5);
		assert.equal(sys.node("A").data.pressure_AH, 2.5);
		assert.equal(sys.node("A").command.write_paras, false);
	});

	test("comm_OK is cleared delay_protect_time after the connection is lost", async (t) => {
		const sys = await create_system(t);
		sys.driver("A").lose_connection();
		await sys.advance(DELAY_PROTECT_TIME - 1000);
		assert.equal(sys.node("A").data.comm_OK, true);
		await sys.advance(1500);
		assert.equal(sys.node("A").data.comm_OK, false);
		await sys.settle();
		assert.equal(sys.section("S1").data.comm_OK, false);
		assert.equal(sys.section("S1").data.hangon_AF, true);
		assert.equal(sys.section("S1").data.protect_F, false);

		sys.driver("A").restore_connection();
		await sys.settle();
		assert.equal(sys.node("A").data.comm_OK, true);
		assert.equal(sys.section("S1").data.comm_OK, true);
		assert.equal(sys.section("S1").data.protect_F, true);
	});

	test("parameters are refreshed from the actuator 2 s after reconnecting", async (t) => {
		const sys = await create_system(t);
		sys.driver("A").lose_connection();
		await sys.advance(MAIN_PERIOD);
		sys.device("A").set("pressure_AH", 1.75);
		sys.driver("A").restore_connection();
		await sys.advance(1000);
		assert.equal(sys.node("A").data.pressure_AH, 1.75);
		assert.equal(sys.node("A").command.pressure_AH, 0);
		await sys.advance(1500);
		assert.equal(sys.node("A").command.pressure_AH, 1.75);
	});

	test("work_OK is cleared while reads keep failing", async (t) => {
		const sys = await create_system(t);
		sys.driver("B").fail_reads();
		await sys.advance(DELAY_PROTECT_TIME + 500);
		assert.equal(sys.node("B").data.work_OK, false);
		await sys.settle();
		assert.equal(sys.section("S1").data.work_OK, false);

		sys.driver("B").restore_reads();
		await sys.settle();
		assert.equal(sys.node("B").data.work_OK, true);
		assert.equal(sys.section("S1").data.work_OK, true);
	});
});

describe("section and line", () => {
	test("pressure warnings and alarms are summed up", async (t) => {
		const sys = await create_system(t);
		sys.device("B").set("pressure_WH_F", true);
		await sys.settle();
		assert.equal(sys.section("S1").data.press_warning_F, true);
		assert.equal(sys.section("S1").data.press_alarm_F, false);
		assert.equal(sys.section("S2").data.press_warning_F, false);

		sys.device("B").set("pressure_AH_F", true);
		await sys.settle();
		assert.equal(sys.section("S1").data.press_alarm_F, true);
		assert.equal(sys.line("L1").data.alarm_F, true);
		assert.equal(sys.section("S1").data.action_F, false);
	});

	test("a flow difference over WH raises the warning after its delay", async (t) => {
		const sys = await create_system(t);
		set_flows(sys, { A: 100, B: 85 });
		await sys.advance(MAIN_PERIOD + 100);
		assert.equal(sys.section("S1").data.flow_warning_F, false);
		await sys.advance(FLOW_ALARM_TIME);
		assert.equal(sys.section("S1").data.flow_warning_F, true);
		assert.equal(sys.section("S1").data.flow_alarm_F, false);

		set_flows(sys, { B: 95 });
		await sys.settle();
		assert.equal(sys.section("S1").data.flow_warning_F, false);
	});

	test("a flow alarm counts down and then stops the whole line", async (t) => {
		const sys = await create_system(t);
		run_pump(sys, true);
		set_flows(sys, { A: 100, B: 70 });
		await sys.advance(FLOW_ALARM_TIME + MAIN_PERIOD);
		const S1 = sys.section("S1");
		const L1 = sys.line("L1");
		assert.equal(S1.data.flow_alarm_F, true);
		assert.equal(S1.data.pre_stop_notice, true);
		assert.equal(L1.data.pre_stop_notice, true);
		assert.ok(S1.data.countdown > 0);
		assert.equal(S1.data.action_F, false);

		await sys.advance(ACTION_TIME + 3 * MAIN_PERIOD);
		assert.equal(S1.data.action_F, true);
		assert.equal(S1.data.line_action_source, true);
		assert.equal(L1.data.autoStopCmd, true);
		assert.equal(L1.data.action_section_ID, 11);
		assert.equal(S1.data.stop_pumps, true);
		assert.equal(sys.device("A").command("stop_pumps"), true);
		assert.equal(sys.records.length, 1);
		assert.equal(sys.records[0].section_ID, 11);
		assert.equal(sys.records[0].flow_action, true);
		assert.equal(sys.records[0].press_action, false);
		assert.equal(sys.records[0].flow_begin, 100);
		assert.equal(sys.records[0].flow_end, 70);
	});

	test("a manual hang-up during the countdown interrupts the stop", async (t) => {
		const sys = await create_system(t);
		run_pump(sys, true);
		set_flows(sys, { A: 100, B: 70 });
		await sys.advance(FLOW_ALARM_TIME + MAIN_PERIOD);
		const S1 = sys.section("S1");
		assert.equal(S1.data.pre_stop_notice, true);

		sys.hmi.set("S1", "flow_override", true);
		await sys.advance(ACTION_TIME + 3 * MAIN_PERIOD);
		assert.equal(S1.data.protect_F, false);
		assert.equal(S1.data.pre_stop_notice, false);
		assert.equal(S1.data.countdown, 0);
		assert.equal(S1.data.action_F, false);
		assert.equal(sys.line("L1").data.autoStopCmd, false);
		assert.equal(sys.device("A").command("stop_pumps"), false);
		assert.equal(sys.records.length, 0);
	});

	test("a manual hang-up interrupts the countdown in the scan of the HMI write", async (t) => {
		const sys = await create_system(t);
		run_pump(sys, true);
		set_flows(sys, { A: 100, B: 70 });
		await sys.advance(FLOW_ALARM_TIME + MAIN_PERIOD);
		const S1 = sys.section("S1");
		assert.equal(S1.data.pre_stop_notice, true);
		assert.ok(S1.data.countdown > 0);

		sys.hmi.set("S1", "flow_override", true);
		await sys.flush();
		assert.equal(S1.data.protect_F, false);
		assert.equal(S1.data.pre_stop_notice, false);
		assert.equal(S1.data.countdown, 0);
		assert.equal(sys.line("L1").data.pre_stop_notice, false);
	});

	test("summaries follow the device data in the scan that loads them", async (t) => {
		const sys = await create_system(t);
		set_flows(sys, { A: 100, B: 70 });
		sys.device("B").set("pressure_AH_F", true);
		// the data are read on the next tick and summed up as soon as they arrive
		await sys.advance(MAIN_PERIOD);
		const S1 = sys.section("S1");
		assert.equal(S1.data.flow_begin, 100);
		assert.equal(S1.data.flow_end, 70);
		assert.equal(S1.data.flow_diff, 30);
		assert.equal(S1.data.flow_alarm_trigger, true);
		assert.equal(S1.data.press_alarm_F, true);
		assert.equal(sys.line("L1").data.alarm_F, true);
	});

	test("a manual stop command takes effect in the scan of the HMI write", async (t) => {
		const sys = await create_system(t);
		run_pump(sys, true);
		await sys.settle();
		sys.hmi.set("S1", "manStopCmd", true);
		await sys.flush();
		assert.equal(sys.section("S1").data.stop_pumps, true);
		assert.equal(sys.node("A").command.stop_pumps, true);
	});

	test("the line flow_override interrupts the countdown in the scan of the HMI write", async (t) => {
		const sys = await create_system(t);
		run_pump(sys, true);
		set_flows(sys, { A: 100, B: 70 });
		await sys.advance(FLOW_ALARM_TIME + MAIN_PERIOD);
		const S1 = sys.section("S1");
		assert.equal(S1.data.pre_stop_notice, true);

		sys.hmi.set("L1", "flow_override", true);
		await sys.flush();
		assert.equal(S1.data.flow_override, false);
		assert.equal(S1.data.protect_F, false);
		assert.equal(S1.data.pre_stop_notice, false);
		assert.equal(S1.data.countdown, 0);
	});

	test("a pressure interlock stops the section until it runs again", async (t) => {
		const sys = await create_system(t);
		const S1 = sys.section("S1");
		const L1 = sys.line("L1");
		run_pump(sys, true);
		sys.device("A").set("pressure_SD_F", true);
		sys.device("A").set("pressure_AH_F", true);
		await sys.settle();
		assert.equal(S1.data.action_F, true);
		assert.equal(S1.data.autoStopCmd, true);
		assert.equal(S1.data.stop_pumps, true);
		assert.equal(L1.data.action_section_ID, 11);
		assert.equal(sys.device("A").command("stop_pumps"), true);
		assert.equal(sys.records.length, 1);
		assert.equal(sys.records[0].press_action, true);
		assert.equal(sys.records[0].flow_action, false);

		// the pumps stop: the command is withdrawn, the action is kept
		run_pump(sys, false);
		sys.device("A").set("pressure_AH_F", false);
		await sys.settle();
		assert.equal(sys.node("A").command.stop_pumps, false);
		assert.equal(sys.device("A").command("stop_pumps"), false);
		assert.equal(S1.data.autoStopCmd, false);
		assert.equal(S1.data.action_F, true);

		run_pump(sys, true);
		await sys.settle();
		assert.equal(S1.data.action_F, false);
		assert.equal(L1.data.action_section_ID, 0);
		assert.equal(sys.records.length, 1);
	});

	test("a prohibited pressure interlock only alarms", async (t) => {
		const sys = await create_system(t);
		run_pump(sys, true);
		sys.device("A").set("pressure_AH_F", true);
		await sys.settle();
		assert.equal(sys.section("S1").data.press_alarm_F, true);
		assert.equal(sys.section("S1").data.action_F, false);
		assert.equal(sys.device("A").command("stop_pumps"), false);
		assert.equal(sys.records.length, 0);
	});

	test("a manual stop on the line stops the sections with running pumps", async (t) => {
		const sys = await create_system(t);
		run_pump(sys, true);
		await sys.settle();
		sys.hmi.set("L1", "manStopCmd", true);
		await sys.settle();
		assert.equal(sys.section("S1").data.stop_pumps, true);
		assert.equal(sys.section("S2").data.stop_pumps, false);
		assert.equal(sys.device("A").command("stop_pumps"), true);

		// withdrawn while the pump still runs
		sys.hmi.set("L1", "manStopCmd", false);
		await sys.settle();
		assert.equal(sys.section("S1").data.stop_pumps, false);
		assert.equal(sys.node("A").command.stop_pumps, false);
		assert.equal(sys.device("A").command("stop_pumps"), false);
	});

	test("manual stop commands are cleared when the pumps stop", async (t) => {
		const sys = await create_system(t);
		run_pump(sys, true);
		await sys.settle();
		sys.hmi.set("S1", "manStopCmd", true);
		sys.hmi.set("L1", "manStopCmd", true);
		await sys.settle();
		assert.equal(sys.section("S1").data.stop_pumps, true);

		run_pump(sys, false);
		await sys.settle();
		assert.equal(sys.section("S1").data.manStopCmd, false);
		assert.equal(sys.line("L1").data.manStopCmd, false);
		assert.equal(sys.section("S1").data.stop_pumps, false);
	});

	test("the line flow_override overrides the protection of all sections", async (t) => {
		const sys = await create_system(t);
		const [S1, S2] = [sys.section("S1"), sys.section("S2")];
		// a hang-up set on one section only
		sys.hmi.set("S2", "flow_override", true);
		sys.hmi.set("L1", "flow_override", true);
		await sys.settle();
		for (const section of [S1, S2]) {
			assert.equal(section.data.protect_F, false);
			assert.equal(section.data.hangon_AF, false);
		}
		// the master switch does not rewrite the section values
		assert.equal(S1.data.flow_override, false);
		assert.equal(S2.data.flow_override, true);

		// the flow judgment goes on, but no countdown starts
		run_pump(sys, true);
		set_flows(sys, { A: 100, B: 70 });
		await sys.advance(FLOW_ALARM_TIME + MAIN_PERIOD);
		assert.equal(S1.data.flow_alarm_F, true);
		assert.equal(S1.data.pre_stop_notice, false);

		// clearing it resumes the sections without their own hang-up
		set_flows(sys, { A: 100, B: 100 });
		sys.hmi.set("L1", "flow_override", false);
		await sys.settle();
		assert.equal(S1.data.protect_F, true);
		assert.equal(S2.data.protect_F, false);
	});

	test("an HMI write of a Real over two registers sets the whole value", async (t) => {
		const sys = await create_system(t);
		sys.hmi.set("S1", "flow_diff_AH", 25.5);
		await sys.settle();
		assert.equal(sys.section("S1").data.flow_diff_AH, 25.5);
	});
});
