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
    data.on("change", (tagname, _o, new_value) => {
        switch (tagname) {
            case "stop_pumps": // set command
                if (new_value == false) {
                    pump_nodes.forEach(node => node.command.stop_pumps = false);
                    pump_nodes.forEach(node => node.command.cancel_stop = true);
                }
                break;
            case "action_F": // log action
                if (new_value == true) {
                    // action_logs(ID, flow_begin, flow_end, flow_diff);
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
    const pump_run = begin_nodes.reduce((acc, current_node) => {
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
    const flow_warning_trigger = (flow_diff > flow_diff_WH) && !bypass;
    data.flowWarningTrigger = flow_warning_trigger;
    if (flow_warning_trigger) section.flow_warning_count++;
    else section.flow_warning_count = 0;
    const flow_alarm_trigger = (flow_diff > flow_diff_AH) && !bypass;
    data.flowAlarmTrigger = flow_alarm_trigger;
    if (flow_alarm_trigger) section.flow_alarm_count++;
    else section.flow_alarm_count = 0;
    const flow_warning_F = section.flow_warning_count > data.flow_diff_WH_delay / 1000;
    data.flow_warning_F = flow_warning_F;
    const flow_alarm_F = section.flow_alarm_count > data.flow_diff_AH_delay / 1000;
    data.flow_alarm_F = flow_alarm_F;
    const pre_stop_notice = flow_alarm_F && protect_F && pump_run;//预备停泵
    data.pre_stop_notice = pre_stop_notice;
    let countdown = 0;
    if (pre_stop_notice) {
        section.action_count++;
        countdown = data.action_time / 1000 - section.action_count;
    } else {
        section.action_count = 0;
        countdown = 0;
    }
    let flow_action = false;
    if (countdown > 0) {
        data.countdown = countdown;
    } else {
        data.countdown = 0;
        flow_action = true;
    }
    let action_F = false;
    let line_action_source = line.data.line_action_source;
    if (flow_action || (press_alarm_F && pump_run)) {
        action_F = true;
        data.autoStopCmd = press_alarm_F; // If the pressure exceeds the limit, the autoStopCmd of this section will be set
        line.data.action_section_ID = ID;
        line.data.autoStopCmd = flow_alarm_F;
        line_action_source = flow_alarm_F;
        data.line_action_source = line_action_source;
    }
    if (!line.data.autoStopCmd) data.line_action_source = false;

    if (!data.pump_run) {
        data.autoStopCmd = false;
        data.manStopCmd = false;
    }
    const autoStopCmd = data.autoStopCmd;
    if (pump_run && !flow_alarm_F && !press_alarm_F && !autoStopCmd && !line_action_source) {
        action_F = false;
    }
    data.action_F = action_F;

    // do stop pumps
    const stop_pumps = autoStopCmd
        || data.manStopCmd
        || line.data.autoStopCmd
        || line.data.manStopCmd;
    data.stop_pumps = stop_pumps;
    pump_nodes.forEach((node) => {
        node.command.stop_pumps = stop_pumps;
    })
}
