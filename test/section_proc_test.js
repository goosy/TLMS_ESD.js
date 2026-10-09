import "./share.js"; // must be first: sets LOG_LEVEL
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import test, { describe } from "node:test";
import { LINE } from "../src/structs/line.js";
import { SECTION } from "../src/structs/section.js";
import { NODE } from "../src/structs/node.js";
import { COMMAND } from "../src/structs/command.js";
import { TData } from "../src/typed_data/TData.js";
import { line_init } from "../src/line_proc.js";
import { section_init, section_loop } from "../src/section_proc.js";

// longer than the chained 50 ms debounces (node -> section -> line -> section)
const SETTLE_MS = 300;
const settle = () => sleep(SETTLE_MS);

let line_seq = 0;

/**
 * Builds a line with an upstream section that owns a pump node and a
 * downstream section without pumps, wired the same way as run_controller.
 * Names are unique per call because debounce timers are keyed by name.
 */
function build_line() {
	const prefix = `L${++line_seq}`;
	const records = [];
	const action_record = {
		data: {},
		add_record() { records.push({ ...this.data }); },
	};
	const line = { ID: 1, name: prefix, controller: { action_record }, sections: [] };
	line.data = new TData(LINE, line.name);

	const make_node = (name) => ({
		name,
		data: new TData(NODE, name),
		command: new TData(COMMAND, `${name}_CMD`),
	});
	const make_section = (ID, name, begin_nodes, end_nodes, pump_nodes) => ({
		ID, name, line, begin_nodes, end_nodes, pump_nodes,
		data: new TData(SECTION, name),
		flow_diff_WH: 10,
		flow_diff_WH_delay: 1000,
		flow_diff_AH: 20,
		flow_diff_AH_delay: 1000,
		action_time: 5000,
	});

	const pump_node = make_node(`${prefix}_pump`);
	const middle_node = make_node(`${prefix}_middle`);
	const end_node = make_node(`${prefix}_end`);
	const upstream = make_section(2, `${prefix}_up`, [pump_node], [middle_node], [pump_node]);
	const downstream = make_section(3, `${prefix}_down`, [middle_node], [end_node], []);
	line.sections.push(upstream, downstream);

	line_init(line);
	for (const section of line.sections) section_init(section);
	return { line, upstream, downstream, pump_node, middle_node, records };
}

async function set_pump_run(context, value) {
	context.pump_node.data.pump_run = value;
	context.upstream.update_pump_run();
	await settle();
}

async function raise_flow_alarm(section) {
	section.data.protect_F = true;
	section.data.flow_alarm_F = true;
	await settle();
}

describe("flow pre-stop notice", () => {
	test("is raised in a section without pumps when the line runs a pump", async () => {
		const context = build_line();
		await set_pump_run(context, true);
		const { line, upstream, downstream } = context;
		assert.equal(upstream.data.pump_run, true);
		assert.equal(downstream.data.pump_run, false);
		assert.equal(line.data.pump_run, true);

		await raise_flow_alarm(downstream);
		assert.equal(downstream.data.pre_stop_notice, true);
		assert.equal(line.data.pre_stop_notice, true);
	});

	test("follows the line pump_run when the alarm comes first", async () => {
		const context = build_line();
		const { line, downstream } = context;
		await raise_flow_alarm(downstream);
		assert.equal(downstream.data.pre_stop_notice, false);

		await set_pump_run(context, true);
		assert.equal(downstream.data.pre_stop_notice, true);
		assert.equal(line.data.pre_stop_notice, true);
	});

	test("is cleared when all pumps on the line stop", async () => {
		const context = build_line();
		const { line, downstream } = context;
		await set_pump_run(context, true);
		await raise_flow_alarm(downstream);
		assert.equal(downstream.data.pre_stop_notice, true);

		await set_pump_run(context, false);
		assert.equal(line.data.pump_run, false);
		assert.equal(downstream.data.pre_stop_notice, false);
		assert.equal(line.data.pre_stop_notice, false);
	});

	test("is not raised without protection", async () => {
		const context = build_line();
		const { downstream } = context;
		await set_pump_run(context, true);
		downstream.data.protect_F = false;
		downstream.data.flow_alarm_F = true;
		await settle();
		assert.equal(downstream.data.pre_stop_notice, false);
	});
});

/**
 * Runs main loop cycles, letting the debounced updates settle in between.
 */
async function run_cycles(context, count) {
	for (let i = 0; i < count; i++) {
		for (const section of context.line.sections) section_loop(section);
		await sleep(60);
	}
}

async function set_pressure(context, node, { alarm, shutdown }) {
	node.data.pressure_AH_F = alarm;
	node.data.pressure_SD_F = shutdown;
	for (const section of context.line.sections) {
		section.update_press_alarm_F();
		section.update_press_SD_trigger();
	}
	await settle();
}

describe("pressure interlock action", () => {
	test("is not triggered by an actuator that prohibits the pressure interlock", async () => {
		const context = build_line();
		const { upstream, pump_node, records } = context;
		await set_pump_run(context, true);
		await set_pressure(context, pump_node, { alarm: true, shutdown: false });
		await run_cycles(context, 2);
		assert.equal(upstream.data.press_alarm_F, true);
		assert.equal(upstream.press_SD_trigger, false);
		assert.equal(upstream.data.action_F, false);
		assert.equal(upstream.data.autoStopCmd, false);
		assert.equal(records.length, 0);
	});

	test("stops the section and resets when it runs again without the trigger", async () => {
		const context = build_line();
		const { line, upstream, pump_node, records } = context;
		await set_pump_run(context, true);
		await set_pressure(context, pump_node, { alarm: true, shutdown: true });
		await run_cycles(context, 2);
		assert.equal(upstream.press_action, true);
		assert.equal(upstream.data.action_F, true);
		assert.equal(upstream.data.autoStopCmd, true);
		assert.equal(upstream.data.stop_pumps, true);
		assert.equal(line.data.action_section_ID, upstream.ID);
		assert.equal(records.length, 1);
		assert.equal(records[0].press_action, true);
		assert.equal(records[0].flow_action, false);

		// pumps stopped: the action is kept while the section is stopped
		await set_pump_run(context, false);
		await set_pressure(context, pump_node, { alarm: false, shutdown: true });
		await run_cycles(context, 2);
		assert.equal(upstream.data.autoStopCmd, false);
		assert.equal(upstream.data.action_F, true);

		await set_pump_run(context, true);
		await run_cycles(context, 2);
		assert.equal(upstream.press_action, false);
		assert.equal(upstream.data.action_F, false);
		assert.equal(line.data.action_section_ID, 0);
		assert.equal(records.length, 1);
	});
});

describe("flow interlock action", () => {
	async function raise_flow_action(context, section) {
		await set_pump_run(context, true);
		section.data.flow_alarm_trigger = true;
		// alarm delay 1000 ms + countdown 5000 ms at 500 ms per cycle
		await run_cycles(context, 16);
	}

	test("is raised in a section without pumps and stops the line", async () => {
		const context = build_line();
		const { line, upstream, downstream, records } = context;
		await raise_flow_action(context, downstream);
		assert.equal(downstream.flow_action, true);
		assert.equal(downstream.data.action_F, true);
		assert.equal(downstream.data.line_action_source, true);
		assert.equal(line.data.autoStopCmd, true);
		assert.equal(line.data.action_section_ID, downstream.ID);
		assert.equal(upstream.data.stop_pumps, true);
		assert.equal(records.length, 1);
		assert.equal(records[0].flow_action, true);
		assert.equal(records[0].press_action, false);
	});

	test("resets when the line runs again and the alarm has left later", async () => {
		const context = build_line();
		const { line, downstream } = context;
		await raise_flow_action(context, downstream);

		await set_pump_run(context, false);
		await run_cycles(context, 2);
		assert.equal(line.data.autoStopCmd, false);
		assert.equal(downstream.data.line_action_source, false);
		assert.equal(downstream.data.action_F, true);

		// restart while the alarm is still present, without protection
		downstream.data.hangon_MF = true;
		await set_pump_run(context, true);
		await run_cycles(context, 2);
		assert.equal(downstream.data.flow_alarm_F, true);
		assert.equal(downstream.data.action_F, true);

		// the alarm leaves while the line keeps running: no latching
		downstream.data.flow_alarm_trigger = false;
		await run_cycles(context, 2);
		assert.equal(downstream.flow_action, false);
		assert.equal(downstream.data.action_F, false);
		assert.equal(line.data.action_section_ID, 0);
	});
});

describe("line action_section_ID", () => {
	test("is not erased by another section resetting its action", async () => {
		const context = build_line();
		const { line, upstream, downstream } = context;
		// downstream keeps a pressure action: it has no pump to run again
		downstream.press_action = true;
		line.data.action_section_ID = downstream.ID;
		upstream.press_action = true;
		upstream.data.action_F = true;
		await set_pump_run(context, true);
		await run_cycles(context, 1);
		assert.equal(upstream.data.action_F, false);
		assert.equal(line.data.action_section_ID, downstream.ID);
	});
});
