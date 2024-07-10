import { MAIN_PERIOD } from "./config.js";
import { logger } from "./util.js";

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
    data.on("change", (tagname, old_value, new_value) => {
        logger.debug(`${name}: ${tagname} ${old_value} => ${new_value}`); // @debug
        switch (tagname) {
            case "stop_pumps": // set command
                if (new_value == false) {
                    pump_nodes.forEach(node => node.command.stop_pumps = false);
                    pump_nodes.forEach(node => node.command.cancel_stop = true);
                }
                break;
            case "action_F": // log action
                if (new_value == true) {
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
                    AR_data.press_action = data.flow_alarm_F;
                    AR_data.flow_action = data.press_alarm_F;
                    AR_data.node1_pump_run = pump_nodes[0]?.data?.pump_run ?? false;
                    AR_data.node2_pump_run = pump_nodes[1]?.data?.pump_run ?? false;
                    AR_data.node3_pump_run = pump_nodes[2]?.data?.pump_run ?? false;
                    action_record.add_record();
                }
                break;
            case "pump_run":
                // if the alarm disappears while the pump is restarted,
                // the action_F will be eliminated.
                // the purpose is to disengage the action_F when the pump is started again.
                const autoStopCmd = data.autoStopCmd;
                if (
                    new_value && !data.flow_alarm_F && !data.press_alarm_F &&
                    !data.autoStopCmd && !data.line_action_source
                ) {
                    // remove action information
                    data.action_F = false;
                    line.data.action_section_ID = 0;
                }
                break;
        }
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
        begin_nodes,
        end_nodes,
        pump_nodes,
    } = section;
    const all_nodes = [...begin_nodes, ...end_nodes];
    const comm_OK = all_nodes.reduce((acc, current_node) => {
        return acc && current_node.data.comm_OK;
    }, true);
    data.comm_OK = comm_OK;
    const work_OK = all_nodes.reduce((acc, current_node) => {
        return acc && current_node.data.work_OK;
    }, true);
    data.work_OK = work_OK;
    const press_warning_F = begin_nodes.reduce((acc, current_node) => {
        return acc || current_node.data.pressure_WH_F;
    }, false);
    data.press_warning_F = press_warning_F;
    const press_alarm_F = begin_nodes.reduce((acc, current_node) => {
        return acc || current_node.data.pressure_SD_F && current_node.data.pressure_AH_F;
    }, false);
    data.press_alarm_F = press_alarm_F;
    const pump_run = pump_nodes.reduce((acc, current_node) => {
        return acc || current_node.data.pump_run;
    }, false);
    data.pump_run = pump_run;
    const pump_change_F = begin_nodes.reduce((acc, current_node) => {
        return acc || current_node.data.pump_change_F;
    }, false);
    data.pump_change_F = pump_change_F;

    const bypass = data.bypass;
    const protect_prereq = comm_OK && work_OK && !pump_change_F && !bypass;
    const hangon_MF = data.hangon_MF;
    const protect_F = protect_prereq && !hangon_MF;
    data.protect_F = protect_F;
    const hangon_AF = !protect_prereq;
    data.hangon_AF = hangon_AF;
    const flow_begin = begin_nodes.reduce((acc, current_node) => {
        return acc + current_node.data.flowmeter;
    }, 0);
    data.flow_begin = flow_begin;
    const flow_end = end_nodes.reduce((acc, current_node) => {
        return acc + current_node.data.flowmeter;
    }, 0);
    data.flow_end = flow_end;
    const flow_diff = flow_begin - flow_end;
    data.flow_diff = flow_diff;
    const flow_warning_trigger = (flow_diff > data.flow_diff_WH) && !bypass;
    data.flow_warning_trigger = flow_warning_trigger;
    if (flow_warning_trigger) section.flow_warning_count += MAIN_PERIOD;
    else section.flow_warning_count = 0;
    const flow_alarm_trigger = (flow_diff > data.flow_diff_AH) && !bypass;
    data.flow_alarm_trigger = flow_alarm_trigger;
    if (flow_alarm_trigger) section.flow_alarm_count += MAIN_PERIOD;
    else section.flow_alarm_count = 0;
    const flow_warning_F = section.flow_warning_count > data.flow_diff_WH_delay;
    data.flow_warning_F = flow_warning_F;
    const flow_alarm_F = section.flow_alarm_count > data.flow_diff_AH_delay;
    data.flow_alarm_F = flow_alarm_F;
    const pre_stop_notice = flow_alarm_F && protect_F && pump_run;//预备停泵
    data.pre_stop_notice = pre_stop_notice;
    let countdown;
    if (pre_stop_notice) {
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
        data.countdown = 0;
        flow_action = true;
    }
    let action_F = data.action_F;
    if (press_alarm_F && pump_run) {
        action_F = true;
        line.data.action_section_ID = ID;
        // only if the pressure exceeds the limit,
        // the autoStopCmd of this section will be set
        data.autoStopCmd = true;
    }
    if (flow_action) {
        action_F = true;
        line.data.action_section_ID = ID;
        // only if the flowmeter exceeds the limit,
        // the autoStopCmd of its line will be set
        line.data.autoStopCmd = true;
        data.line_action_source = true;
    } else {
        data.line_action_source &&= line.data.autoStopCmd;
    }

    if (!pump_run) {
        data.autoStopCmd = false;
        data.manStopCmd = false;
    }
    data.action_F = action_F;

    // do stop pumps
    const stop_pumps = data.autoStopCmd || data.manStopCmd || line.data.autoStopCmd || line.data.manStopCmd;
    data.stop_pumps = stop_pumps && pump_run;
    pump_nodes.forEach((node) => {
        node.command.stop_pumps = stop_pumps && node.data.pump_run;
    });
}
