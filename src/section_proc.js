import { MAIN_PERIOD } from "./config.js";
import { debouncify, logger } from "./util.js";

function get_update_fn(operation, section, section_prop, nodes, node_prop = section_prop) {
    const debounce_key = `section${section.name}_${section_prop}_update`;
    let update_fn = null;
    if (operation === 'AND') update_fn = () => {
        section.data[section_prop] = nodes.every((node) => node.data[node_prop]);
    }
    if (operation === 'OR') update_fn = () => {
        section.data[section_prop] = nodes.some((node) => node.data[node_prop]);
    }
    if (operation === 'ADD') update_fn = () => {
        section.data[section_prop] = nodes.reduce((acc, node) => {
            return acc + node.data[node_prop];
        }, 0);
    }
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
        'AND',
        section, 'comm_OK',
        all_nodes
    );
    section.update_work_OK = get_update_fn(
        'AND',
        section, 'work_OK',
        all_nodes
    );
    section.update_press_warning_F = get_update_fn(
        'OR',
        section, 'press_warning_F',
        all_nodes, 'pressure_WH_F',
    );
    section.update_press_alarm_F = get_update_fn(
        'OR',
        section, 'press_alarm_F',
        all_nodes, 'pressure_AH_F',
    );
    section.update_pump_run = get_update_fn(
        'OR',
        section, 'pump_run',
        pump_nodes
    );
    section.update_pump_change_F = get_update_fn(
        'OR',
        section, 'pump_change_F',
        pump_nodes
    );
    section.update_flow_begin = get_update_fn(
        'ADD',
        section, 'flow_begin',
        begin_nodes, 'flowmeter'
    );
    section.update_flow_end = get_update_fn(
        'ADD',
        section, 'flow_end',
        end_nodes, 'flowmeter'
    );
    section.update_flow_diff = debouncify(
        `section${name}_flow_diff_update`,
        () => data.flow_diff = data.flow_begin - data.flow_end,
        50
    );
    section.update_pre_stop_notice = debouncify(
        `section${name}_pre_stop_notice_update`,
        () => data.pre_stop_notice = data.flow_alarm_F && data.pump_run && data.protect_F,
        50
    );
    section.update_comm_OK();
    section.update_work_OK();
    section.update_press_warning_F();
    section.update_press_alarm_F();
    section.update_pump_run();
    section.update_pump_change_F();
    section.update_flow_begin();
    section.update_flow_end();

    data.on("change", (tagname, old_value, new_value) => {
        logger.debug(`section_${name}: ${tagname} ${old_value} => ${new_value}`);
        if (tagname === 'flow_begin' || tagname === 'flow_end') {
            section.update_flow_diff();
            return;
        }
    });
    data.get('stop_pumps').on("change", (_, new_value) => {// set command
        if (new_value == true) {
            pump_nodes.forEach((node) => {
                node.command.stop_pumps = node.data.pump_run
                logger.info(`send stop_pumps command to ${node.name} actuator`);
            });
        } else {
            pump_nodes.forEach(node => {
                node.command.stop_pumps = false;
                node.command.cancel_stop = true;
                logger.info(`send cancel_stop command to ${node.name} actuator`);
            });
        }
    });
    data.get('action_F').on("change", (_, new_value) => { // log action
        if (new_value == true) {
            logger.info(`section ${name}: interlock action`);
            // logs: ID, flow_begin, flow_end, flow_diff
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
            AR_data.press_action = data.press_alarm_F;
            AR_data.flow_action = data.flow_alarm_F;
            AR_data.node1_pump_run = pump_nodes[0]?.data?.pump_run ?? false;
            AR_data.node2_pump_run = pump_nodes[1]?.data?.pump_run ?? false;
            AR_data.node3_pump_run = pump_nodes[2]?.data?.pump_run ?? false;
            action_record.add_record();
        } else {
            logger.info(`section ${name}: reset action flag`);
        }
    });
    data.get('pump_run').on("change", (_, new_value) => {
        // if the alarm disappears while the pump is restarted,
        // the action_F will be eliminated.
        // the purpose is to disengage the action_F when the pump is started again.
        if (
            new_value && !data.flow_alarm_F && !data.press_alarm_F &&
            data.action_F &&
            !data.autoStopCmd && !data.line_action_source
        ) {
            // remove action information
            data.action_F = false;
            line.data.action_section_ID = 0;
        }
        if (!new_value) {
            data.autoStopCmd = false;
            data.manStopCmd = false;
        }
        section.update_pre_stop_notice();
        line.update_pump_run();
    });
    data.get('flow_warning_F').on("change", (_, new_value) => {
        if (new_value == true) {
            logger.warn(`section ${name}: flowmeter warning arrived`);
        } else {
            logger.info(`section ${name}: flowmeter warning left`);
        }
    });
    data.get('flow_alarm_F').on("change", (_, new_value) => {
        if (new_value == true) {
            logger.error(`section ${name}: flowmeter alarm arrived`);
        } else {
            logger.info(`section ${name}: flowmeter alarm left`);
        }
        section.update_pre_stop_notice();
        line.update_alarm_F();
    });
    data.get('protect_F').on("change", (_o, _n) => {
        section.update_pre_stop_notice();
    });
    data.get('hangon_MF').on("change", (_, new_value) => {
        if (new_value == true) {
            logger.warn(`section ${name}: manually stop protection`);
        } else {
            logger.info(`section ${name}: manually resume protection`);
        }
    });
    data.get('hangon_AF').on("change", (_, new_value) => {
        if (new_value == true) {
            logger.info(`section ${name}: automatically stop protection`);
        } else {
            logger.info(`section ${name}: automatically resume protection`);
        }
    });
    data.get('pre_stop_notice').on("change", (_, new_value) => {
        if (new_value == true) {
            logger.info(`section ${name} start action countdown`);
        }
    });
    data.get('press_alarm_F').on("change", (_, new_value) => {
        if (new_value == true) {
            logger.error(`section ${name}: pressure alarm arrived`);
        } else {
            logger.info(`section ${name}: pressure alarm left`);
        }
        line.update_alarm_F();
    });
    data.get('flow_diff').on("change", (_, new_value) => {
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
    let flow_action = false;
    if (countdown >= 0) {
        data.countdown = countdown / 1000;
    } else {
        // When countdown < 0 (implies pre_stop_notice),
        // flow_action is set
        data.countdown = 0;
        flow_action = true;
    }

    // action trigger
    if (section.press_alarm_F && pump_run) {
        data.action_F = true;
        line.data.action_section_ID = ID;
        // only if the pressure exceeds the limit,
        // the autoStopCmd of this section will be set
        data.autoStopCmd = true;
    }
    if (flow_action) {
        data.action_F = true;
        line.data.action_section_ID = ID;
        // only if the flowmeter exceeds the limit,
        // the autoStopCmd of its line will be set
        line.data.autoStopCmd = true;
        data.line_action_source = true;
    } else {
        data.line_action_source &&= line.data.autoStopCmd;
    }

    // do stop pumps
    const stop_pumps = data.autoStopCmd || data.manStopCmd || line.data.autoStopCmd || line.data.manStopCmd;
    data.stop_pumps = stop_pumps && pump_run;
}
