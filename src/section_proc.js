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
    data.set("ID", ID);
    data.name = name;
    section.flow_warning_count = 0;
    section.flow_alarm_count = 0;
    section.action_count = 0;
    data.on("change", (tagname, _o, new_value) => {
        switch (tagname) {
            case "stop_pumps": // set command
                if (new_value == false) {
                    pump_nodes.forEach(node => node.command.set("stop_pumps", false));
                    pump_nodes.forEach(node => node.command.set("cancel_stop", true));
                }
                break;
            case "action_F": // log action
                if (new_value == true) {
                    // action_logs(ID, flow_begin, flow_end, flow_diff);
                }
                break;
        }
    });
    data.set("flow_diff_WH", flow_diff_WH);
    data.set("flow_diff_WH_delay", flow_diff_WH_delay);
    data.set("flow_diff_AH", flow_diff_AH);
    data.set("flow_diff_AH_delay", flow_diff_AH_delay);
    data.set("action_time", action_time);
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
        return acc && current_node.data.get("comm_OK");
    }, true);
    data.set("comm_OK", comm_OK);
    const work_OK = all_nodes.reduce((acc, current_node) => {
        return acc && current_node.data.get("work_OK");
    }, true);
    data.set("work_OK", work_OK);
    const press_warning_F = begin_nodes.reduce((acc, current_node) => {
        return acc || current_node.data.get("pressure_WH_F");
    }, false);
    data.set("press_warning_F", press_warning_F);
    const press_alarm_F = begin_nodes.reduce((acc, current_node) => {
        return acc || current_node.data.get("pressure_SD_F") && current_node.data.get("pressure_AH_F");
    }, false);
    data.set("press_alarm_F", press_alarm_F);
    const pump_run = begin_nodes.reduce((acc, current_node) => {
        return acc || current_node.data.get("pump_run");
    }, false);
    data.set("pump_run", pump_run);
    const pump_change_F = begin_nodes.reduce((acc, current_node) => {
        return acc || current_node.data.get("pump_change_F");
    }, false);
    data.set("pump_change_F", pump_change_F);

    const bypass = data.get("bypass");
    const protect_prereq = comm_OK && work_OK && !pump_change_F && !bypass;
    const hangon_MF = data.get("hangon_MF");
    const protect_F = protect_prereq && !hangon_MF;
    data.set("protect_F", protect_F);
    const hangon_AF = !protect_prereq;
    data.set("hangon_AF", hangon_AF);
    const flow_begin = begin_nodes.reduce((acc, current_node) => {
        return acc + current_node.data.get("flowmeter");
    }, 0);
    data.set("flow_begin", flow_begin);
    const flow_end = end_nodes.reduce((acc, current_node) => {
        return acc + current_node.data.get("flowmeter");
    }, 0);
    data.set("flow_end", flow_end);
    const flow_diff = flow_begin - flow_end;
    data.set("flow_diff", flow_diff);
    const flow_warning_trigger = (flow_diff > flow_diff_WH) && !bypass;
    data.set("flowWarningTrigger", flow_warning_trigger);
    if (flow_warning_trigger) section.flow_warning_count++;
    else section.flow_warning_count = 0;
    const flow_alarm_trigger = (flow_diff > flow_diff_AH) && !bypass;
    data.set("flowAlarmTrigger", flow_alarm_trigger);
    if (flow_alarm_trigger) section.flow_alarm_count++;
    else section.flow_alarm_count = 0;
    const flow_warning_F = section.flow_warning_count > data.get("flow_diff_WH_delay") / 1000;
    data.set("flow_warning_F", flow_warning_F);
    const flow_alarm_F = section.flow_alarm_count > data.get("flow_diff_AH_delay") / 1000;
    data.set("flow_alarm_F", flow_alarm_F);
    const pre_stop_notice = flow_alarm_F && protect_F && pump_run;//预备停泵
    data.set("pre_stop_notice", pre_stop_notice);
    let countdown = 0;
    if (pre_stop_notice) {
        section.action_count++;
        countdown = data.get("action_time") / 1000 - section.action_count;
    } else {
        section.action_count = 0;
        countdown = 0;
    }
    data.set("countdown", countdown);
    let action_F = false;
    let flow_action = false;
    if (countdown < 0) {
        countdown = 0;
        flow_action = true;
    }
    const line_action_source = line.data.get("line_action_source");
    if (flow_action || (press_alarm_F && pump_run)) {
        action_F = true;
        data.set("autoStopCmd", press_alarm_F); // If the pressure exceeds the limit, the autoStopCmd of this section will be set
        line.data.set("action_section_ID", ID);
        line.data.set("autoStopCmd", flow_alarm_F);
        line_action_source = flow_alarm_F;
        data.set("line_action_source", line_action_source);
    }
    if (!line.data.get("autoStopCmd")) data.set("line_action_source", false);

    if (!data.get("pump_run")) {
        data.set("autoStopCmd", false);
        data.set("manStopCmd", false);
    }
    const autoStopCmd = data.get("autoStopCmd");
    if (pump_run && !flow_alarm_F && !press_alarm_F && !autoStopCmd && !line_action_source) {
        action_F = false;
    }
    data.set("action_F", action_F);

    // do stop pumps
    const stop_pumps = autoStopCmd
        || data.get("manStopCmd")
        || line.data.get("autoStopCmd")
        || line.data.get("manStopCmd");
    data.set("stop_pumps", stop_pumps);
    pump_nodes.forEach((node) => {
        node.command.set("stop_pumps", stop_pumps);
    })
}
