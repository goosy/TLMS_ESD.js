import { derive, on_delay, tick_act } from "./rules.js";
import { logger } from "./util.js";

export function section_init(section) {
	const {
		ID,
		name,
		data,
		pump_nodes,
		flow_diff_WH,
		flow_diff_WH_delay,
		flow_diff_AH,
		flow_diff_AH_delay,
		action_time,
	} = section;

	data.on("change", (tagname, old_value, new_value) => {
		logger.debug(`section_${name}: ${tagname} ${old_value} => ${new_value}`);
	});
	data.get("stop_pumps").on("change", (_, new_value) => { // set command
		if (new_value) {
			for (const node of pump_nodes) {
				node.command.stop_pumps = node.data.pump_run;
				logger.info(`send stop_pumps command to ${node.name} actuator`);
			}
		} else {
			for (const node of pump_nodes) {
				node.command.stop_pumps = false;
				node.command.cancel_stop = true;
				logger.info(`send cancel_stop command to ${node.name} actuator`);
			};
		}
	});
	data.get("action_F").on("change", (_, new_value) => {
		if (new_value) {
			logger.info(`section ${name}: interlock action`);
		} else {
			logger.info(`section ${name}: reset action flag`);
		}
	});
	data.get("pump_run").on("change", (_, new_value) => {
		if (!new_value) {
			data.autoStopCmd = false;
			data.manStopCmd = false;
		}
	});
	data.get("flow_warning_F").on("change", (_, new_value) => {
		if (new_value) {
			logger.warn(`section ${name}: flowmeter warning arrived`);
		} else {
			logger.info(`section ${name}: flowmeter warning left`);
		}
	});
	data.get("flow_alarm_F").on("change", (_, new_value) => {
		if (new_value) {
			logger.error(`section ${name}: flowmeter alarm arrived`);
		} else {
			logger.info(`section ${name}: flowmeter alarm left`);
		}
	});
	data.get("flow_override").on("change", (_, new_value) => {
		if (new_value) {
			logger.warn(`section ${name}: manually stop protection`);
		} else {
			logger.info(`section ${name}: manually resume protection`);
		}
	});
	data.get("hangon_AF").on("change", (_, new_value) => {
		if (new_value) {
			logger.info(`section ${name}: automatically stop protection`);
		} else {
			logger.info(`section ${name}: automatically resume protection`);
		}
	});
	data.get("pre_stop_notice").on("change", (_, new_value) => {
		if (new_value) {
			logger.info(`section ${name} start action countdown`);
		}
	});
	data.get("press_alarm_F").on("change", (_, new_value) => {
		if (new_value) {
			logger.error(`section ${name}: pressure alarm arrived`);
		} else {
			logger.info(`section ${name}: pressure alarm left`);
		}
	});
	data.ID = ID;
	data.name = name;
	data.flow_diff_WH = flow_diff_WH;
	data.flow_diff_WH_delay = flow_diff_WH_delay;
	data.flow_diff_AH = flow_diff_AH;
	data.flow_diff_AH_delay = flow_diff_AH_delay;
	data.action_time = action_time;
}

/**
 * Declares the variables and rules of a section (doc/design-scan.md 7.5).
 * Called once the whole object graph is built: the rules read the data
 * blocks of the nodes and of the line.
 *
 * @param {Object} section
 * @param {import("./scan.js").Scheduler} scheduler
 */
export function section_rules(section, scheduler) {
	const { name, data, line, begin_nodes, end_nodes, pump_nodes } = section;
	const all_nodes = [...begin_nodes, ...end_nodes];
	const line_data = line.data;
	const record_data = line.controller.action_record.data;
	const node_keys = (nodes, ...tags) => nodes.flatMap((node) => tags.map((tag) => [node.data, tag]));
	const add = (spec) => scheduler.add_rule(derive({ ...spec, name: `section ${name} ${spec.name}` }));

	// variables passed between the rules (doc/design-scan.md 7.5)
	for (const var_name of ["press_SD_trigger", "countdown_expired", "press_action", "flow_action"]) {
		section[var_name] = false;
		scheduler.add_var(section, var_name);
	}

	// node states summed up
	const every = (tag, nodes, node_tag = tag) => add({
		name: tag,
		reads: node_keys(nodes, node_tag),
		writes: [[data, tag]],
		run: () => { data[tag] = nodes.every((node) => node.data[node_tag]); },
	});
	const some = (tag, nodes, node_tag = tag) => add({
		name: tag,
		reads: node_keys(nodes, node_tag),
		writes: [[data, tag]],
		run: () => { data[tag] = nodes.some((node) => node.data[node_tag]); },
	});
	const sum = (tag, nodes, node_tag) => add({
		name: tag,
		reads: node_keys(nodes, node_tag),
		writes: [[data, tag]],
		run: () => { data[tag] = nodes.reduce((acc, node) => acc + node.data[node_tag], 0); },
	});
	every("comm_OK", all_nodes);
	every("work_OK", all_nodes);
	some("press_warning_F", all_nodes, "pressure_WH_F");
	some("press_alarm_F", all_nodes, "pressure_AH_F");
	some("pump_run", pump_nodes);
	some("pump_change_F", pump_nodes);
	sum("flow_begin", begin_nodes, "flowmeter");
	sum("flow_end", end_nodes, "flowmeter");

	add({
		name: "flow_diff",
		reads: [[data, "flow_begin"], [data, "flow_end"]],
		writes: [[data, "flow_diff"]],
		run: () => { data.flow_diff = data.flow_begin - data.flow_end; },
	});
	add({
		name: "flow triggers",
		reads: [[data, "flow_diff"], [data, "flow_diff_WH"], [data, "flow_diff_AH"]],
		writes: [[data, "flow_warning_trigger"], [data, "flow_alarm_trigger"]],
		run: () => {
			data.flow_warning_trigger = data.flow_diff > data.flow_diff_WH;
			data.flow_alarm_trigger = data.flow_diff > data.flow_diff_AH;
		},
	});
	// Pressure interlock trigger: only actuators that allow the pressure
	// interlock (pressure_SD_F) take part (spec 5.2).
	add({
		name: "press_SD_trigger",
		reads: node_keys(all_nodes, "pressure_AH_F", "pressure_SD_F"),
		writes: [[section, "press_SD_trigger"]],
		run: () => {
			const value = all_nodes.some((node) => node.data.pressure_AH_F && node.data.pressure_SD_F);
			if (value === section.press_SD_trigger) return;
			section.press_SD_trigger = value;
			logger.info(`section ${name}: pressure interlock trigger ${value ? "raised" : "cleared"}`);
		},
	});
	add({
		name: "protect_F",
		reads: [[data, "comm_OK"], [data, "work_OK"], [data, "pump_change_F"], [data, "flow_override"], [line_data, "flow_override"]],
		writes: [[data, "protect_F"], [data, "hangon_AF"]],
		run: () => {
			const protect_prereq = data.comm_OK && data.work_OK && !data.pump_change_F;
			// the line flow_override is a master switch, it never rewrites the section one
			data.protect_F = protect_prereq && !data.flow_override && !line_data.flow_override;
			data.hangon_AF = !protect_prereq;
		},
	});
	add({
		name: "flow_warning_F",
		reads: [[data, "flow_warning_trigger"], [data, "flow_diff_WH_delay"]],
		writes: [[data, "flow_warning_F"]],
		run: (ticker) => {
			data.flow_warning_F = on_delay(ticker, data.flow_warning_trigger, data.flow_diff_WH_delay);
		},
	});
	add({
		name: "flow_alarm_F",
		reads: [[data, "flow_alarm_trigger"], [data, "flow_diff_AH_delay"]],
		writes: [[data, "flow_alarm_F"]],
		run: (ticker) => {
			data.flow_alarm_F = on_delay(ticker, data.flow_alarm_trigger, data.flow_diff_AH_delay);
		},
	});
	add({
		name: "pre_stop_notice",
		reads: [[data, "flow_alarm_F"], [line_data, "pump_run"], [data, "protect_F"]],
		writes: [[data, "pre_stop_notice"]],
		run: () => {
			// The flow interlock stops the whole line, so it is gated by the
			// line's pump_run: the leaking section itself may have no running
			// pump (spec 5.2).
			data.pre_stop_notice = data.flow_alarm_F && line_data.pump_run && data.protect_F;
		},
	});
	add({
		name: "countdown",
		reads: [[data, "pre_stop_notice"], [data, "action_time"]],
		writes: [[data, "countdown"], [section, "countdown_expired"]],
		run: (ticker) => {
			if (data.pre_stop_notice) ticker.start();
			else ticker.stop();
			const countdown = data.pre_stop_notice ? data.action_time - ticker.elapsed : 0;
			// a negative countdown (implies pre_stop_notice) triggers the flow action
			section.countdown_expired = countdown < 0;
			data.countdown = section.countdown_expired ? 0 : countdown / 1000;
		},
	});

	// the interlock actions, still a coarse rule run on periodic ticks (doc/design-scan.md 10.2)
	scheduler.add_rule(tick_act({
		name: `section ${name} actions`,
		reads: [
			[section, "press_SD_trigger"], [section, "countdown_expired"],
			[data, "pump_run"], [data, "flow_alarm_F"], [line_data, "pump_run"],
			// the action record
			[data, "ID"], [data, "flow_begin"], [data, "flow_end"], [data, "flow_diff"],
			...node_keys(all_nodes, "pressure", "ID"),
			...node_keys(pump_nodes, "pump_run"),
		],
		writes: [
			[section, "press_action"], [section, "flow_action"],
			[data, "autoStopCmd"], [data, "line_action_source"],
			[line_data, "autoStopCmd"], [line_data, "action_section_ID"],
			...[...record_data.layout.entries.keys()].map((tag) => [record_data, tag]),
		],
		run: () => section_loop(section),
	}));

	add({
		name: "action_F",
		reads: [[section, "press_action"], [section, "flow_action"]],
		writes: [[data, "action_F"]],
		run: () => { data.action_F = section.press_action || section.flow_action; },
	});
	add({
		name: "stop_pumps",
		reads: [
			[data, "autoStopCmd"], [data, "manStopCmd"],
			[line_data, "autoStopCmd"], [line_data, "manStopCmd"],
			[data, "pump_run"],
		],
		writes: [[data, "stop_pumps"]],
		run: () => {
			const stop_pumps = data.autoStopCmd || data.manStopCmd || line_data.autoStopCmd || line_data.manStopCmd;
			data.stop_pumps = stop_pumps && data.pump_run;
		},
	});
}

function add_action_record(section) {
	const { data, line, begin_nodes, end_nodes, pump_nodes } = section;
	const action_record = line.controller.action_record;
	const AR_data = action_record.data;
	AR_data.section_ID = data.ID;
	AR_data.flow_begin = data.flow_begin;
	AR_data.flow_end = data.flow_end;
	AR_data.flow_diff = data.flow_diff;
	AR_data.node1_press = begin_nodes[0]?.data?.pressure ?? 0;
	AR_data.node2_press = begin_nodes[1]?.data?.pressure ?? 0;
	AR_data.node3_press = begin_nodes[2]?.data?.pressure ?? 0;
	AR_data.node4_press = end_nodes[0]?.data?.pressure ?? 0;
	AR_data.node1_ID = begin_nodes[0]?.data?.ID ?? 0;
	AR_data.node2_ID = begin_nodes[1]?.data?.ID ?? 0;
	AR_data.node3_ID = begin_nodes[2]?.data?.ID ?? 0;
	AR_data.node4_ID = end_nodes[0]?.data?.ID ?? 0;
	// the causes are the action flags, not the alarm states (spec 5.4)
	AR_data.press_action = section.press_action;
	AR_data.flow_action = section.flow_action;
	AR_data.node1_pump_run = pump_nodes[0]?.data?.pump_run ?? false;
	AR_data.node2_pump_run = pump_nodes[1]?.data?.pump_run ?? false;
	AR_data.node3_pump_run = pump_nodes[2]?.data?.pump_run ?? false;
	action_record.add_record();
}

/**
 * The interlock actions of a section, once per periodic tick: the pressure
 * and flow actions, the stop commands they set and the action record.
 */
function section_loop(section) {
	const {
		ID,
		data,
		line,
	} = section;

	const pump_run = data.pump_run;
	const press_action_old = section.press_action;
	const flow_action_old = section.flow_action;

	// pressure action: stops this section only, not gated by protect_F
	if (section.press_SD_trigger && pump_run) {
		section.press_action = true;
		data.autoStopCmd = true;
	} else if (pump_run && !data.autoStopCmd) {
		// the section runs again without the trigger
		section.press_action = false;
	}

	// flow action: stops the whole line
	if (section.countdown_expired) {
		section.flow_action = true;
		line.data.autoStopCmd = true;
		data.line_action_source = true;
	} else {
		data.line_action_source &&= line.data.autoStopCmd;
		if (line.data.pump_run && !data.flow_alarm_F && !data.line_action_source) {
			// the line runs again without the alarm
			section.flow_action = false;
		}
	}

	const press_raised = section.press_action && !press_action_old;
	const flow_raised = section.flow_action && !flow_action_old;
	if (press_raised) logger.error(`section ${section.name}: pressure interlock action`);
	if (flow_raised) logger.error(`section ${section.name}: flow interlock action`);
	if (press_raised || flow_raised) {
		line.data.action_section_ID = ID;
		add_action_record(section);
	}
	const action_F = section.press_action || section.flow_action;
	if (!action_F && line.data.action_section_ID === ID) {
		// do not erase the action of another section
		line.data.action_section_ID = 0;
	}
}
