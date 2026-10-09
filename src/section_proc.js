import { MAIN_PERIOD } from "./config.js";
import { debouncify, logger } from "./util.js";

function get_update_fn(operation, section, section_prop, nodes, node_prop = section_prop) {
	const debounce_key = `section${section.name}_${section_prop}_update`;
	let update_fn = null;
	if (operation === "AND") update_fn = () => {
		section.data[section_prop] = nodes.every((node) => node.data[node_prop]);
	};
	if (operation === "OR") update_fn = () => {
		section.data[section_prop] = nodes.some((node) => node.data[node_prop]);
	};
	if (operation === "ADD") update_fn = () => {
		section.data[section_prop] = nodes.reduce((acc, node) => {
			return acc + node.data[node_prop];
		}, 0);
	};
	if (update_fn) return debouncify(debounce_key, update_fn, 50);
}

export function section_init(section) {
	const {
		ID,
		name,
		data,
		line,
		begin_nodes,
		end_nodes,
		pump_nodes,
		flow_diff_WH,
		flow_diff_WH_delay,
		flow_diff_AH,
		flow_diff_AH_delay,
		action_time,
	} = section;

	const all_nodes = [...begin_nodes, ...end_nodes];
	section.update_comm_OK = get_update_fn(
		"AND",
		section, "comm_OK",
		all_nodes,
	);
	section.update_work_OK = get_update_fn(
		"AND",
		section, "work_OK",
		all_nodes,
	);
	section.update_press_warning_F = get_update_fn(
		"OR",
		section, "press_warning_F",
		all_nodes, "pressure_WH_F",
	);
	section.update_press_alarm_F = get_update_fn(
		"OR",
		section, "press_alarm_F",
		all_nodes, "pressure_AH_F",
	);
	section.update_pump_run = get_update_fn(
		"OR",
		section, "pump_run",
		pump_nodes,
	);
	section.update_pump_change_F = get_update_fn(
		"OR",
		section, "pump_change_F",
		pump_nodes,
	);
	section.update_flow_begin = get_update_fn(
		"ADD",
		section, "flow_begin",
		begin_nodes, "flowmeter",
	);
	section.update_flow_end = get_update_fn(
		"ADD",
		section, "flow_end",
		end_nodes, "flowmeter",
	);
	section.update_flow_diff = debouncify(
		`section${name}_flow_diff_update`,
		() => { data.flow_diff = data.flow_begin - data.flow_end; },
		50,
	);
	section.update_pre_stop_notice = debouncify(
		`section${name}_pre_stop_notice_update`,
		() => {
			// The flow interlock stops the whole line, so it is gated by the
			// line's pump_run: the leaking section itself may have no running
			// pump (spec 5.2).
			data.pre_stop_notice = data.flow_alarm_F && line.data.pump_run && data.protect_F;
		},
		50,
	);
	// Pressure interlock trigger (variable): only actuators that allow the
	// pressure interlock (pressure_SD_F) take part (spec 5.2).
	section.press_SD_trigger = false;
	section.update_press_SD_trigger = debouncify(
		`section${name}_press_SD_trigger_update`,
		() => {
			const value = all_nodes.some((node) => node.data.pressure_AH_F && node.data.pressure_SD_F);
			if (value === section.press_SD_trigger) return;
			section.press_SD_trigger = value;
			logger.info(`section ${name}: pressure interlock trigger ${value ? "raised" : "cleared"}`);
		},
		50,
	);
	// Action flags (variables), action_F is derived from them in section_loop.
	section.press_action = false;
	section.flow_action = false;
	section.update_comm_OK();
	section.update_work_OK();
	section.update_press_warning_F();
	section.update_press_alarm_F();
	section.update_press_SD_trigger();
	section.update_pump_run();
	section.update_pump_change_F();
	section.update_flow_begin();
	section.update_flow_end();

	data.on("change", (tagname, old_value, new_value) => {
		logger.debug(`section_${name}: ${tagname} ${old_value} => ${new_value}`);
		if (tagname === "flow_begin" || tagname === "flow_end") {
			section.update_flow_diff();
			return;
		}
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
		section.update_pre_stop_notice();
		line.update_pump_run();
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
		section.update_pre_stop_notice();
		line.update_alarm_F();
	});
	data.get("protect_F").on("change", (_o, _n) => {
		section.update_pre_stop_notice();
	});
	data.get("hangon_MF").on("change", (_, new_value) => {
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
		line.update_pre_stop_notice();
	});
	data.get("press_alarm_F").on("change", (_, new_value) => {
		if (new_value) {
			logger.error(`section ${name}: pressure alarm arrived`);
		} else {
			logger.info(`section ${name}: pressure alarm left`);
		}
		line.update_alarm_F();
	});
	data.get("flow_diff").on("change", (_, new_value) => {
		data.flow_warning_trigger = (new_value > data.flow_diff_WH) && !data.bypass;
		data.flow_alarm_trigger = (new_value > data.flow_diff_AH) && !data.bypass;
	});
	data.ID = ID;
	data.name = name;
	section.flow_warning_count = 0;
	section.flow_alarm_count = 0;
	section.action_count = 0;
	data.flow_diff_WH = flow_diff_WH;
	data.flow_diff_WH_delay = flow_diff_WH_delay;
	data.flow_diff_AH = flow_diff_AH;
	data.flow_diff_AH_delay = flow_diff_AH_delay;
	data.action_time = action_time;
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

export function section_loop(section) {
	const {
		ID,
		data,
		line,
	} = section;

	const pump_run = data.pump_run;
	const protect_prereq = data.comm_OK && data.work_OK && !data.pump_change_F && !data.bypass;
	data.protect_F = protect_prereq && !data.hangon_MF;
	data.hangon_AF = !protect_prereq;

	// flow_diff trigger action
	if (data.flow_warning_trigger) section.flow_warning_count += MAIN_PERIOD;
	else section.flow_warning_count = 0;
	if (data.flow_alarm_trigger) section.flow_alarm_count += MAIN_PERIOD;
	else section.flow_alarm_count = 0;
	data.flow_warning_F = section.flow_warning_count > data.flow_diff_WH_delay;
	data.flow_alarm_F = section.flow_alarm_count > data.flow_diff_AH_delay;
	let countdown;
	if (data.pre_stop_notice) {
		section.action_count += MAIN_PERIOD;
		countdown = data.action_time - section.action_count;
	} else {
		section.action_count = 0;
		countdown = 0;
	}
	let countdown_expired = false;
	if (countdown >= 0) {
		data.countdown = countdown / 1000;
	} else {
		// When countdown < 0 (implies pre_stop_notice),
		// the flow action is triggered
		data.countdown = 0;
		countdown_expired = true;
	}

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
	if (countdown_expired) {
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
	data.action_F = action_F;

	// do stop pumps
	const stop_pumps = data.autoStopCmd || data.manStopCmd || line.data.autoStopCmd || line.data.manStopCmd;
	data.stop_pumps = stop_pumps && pump_run;
}
