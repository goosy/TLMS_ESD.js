import { cfg_lines, cfg_actuators, cfg_controllers } from "./config.js";

function add_actuator(section, cfg_node) {
    const ID = cfg_node.id;
    const {
        name, IP,
        is_begin, is_end, has_pumps,
    } = cfg_node
    let driver_info = null;
    if (cfg_node.modbus_server) {
        driver_info = {
            ...cfg_node.modbus_server,
            protocol: 'modbusTCP',
            IP,
        };
    } else if (cfg_node.s7_server) {
        driver_info = {
            ...cfg_node.s7_server,
            protocol: 'S7',
            host: IP,
        };
    }

    const actuator = {
        ID, name,
        driver_info,
        is_begin, is_end, has_pumps, section
    };
    if (is_begin) section.begin_nodes.push(actuator);
    if (is_end) section.end_nodes.push(actuator);
    if (has_pumps) section.pump_nodes.push(actuator);
}

export async function prepare_controller(controller_name) {
    const controller = cfg_controllers.find(c => c.name === controller_name);
    if (controller == undefined) {
        return null;
    }
    controller.lines = [];

    for (const cfg_line of cfg_lines) {
        if (cfg_line.controller.name !== controller_name) continue;
        const ID = cfg_line.id;
        const name = cfg_line.name;
        const line = { ID, name, controller, sections: [] };
        controller.lines.push(line);
        for (const cfg_section of cfg_line.sections) {
            const ID = cfg_section.id;
            const name = cfg_section.name;
            const flow_diff_WH = cfg_section.flow_diff_WH;
            const flow_diff_WH_delay = cfg_section.flow_diff_WH_delay;
            const flow_diff_AH = cfg_section.flow_diff_AH;
            const flow_diff_AH_delay = cfg_section.flow_diff_AH_delay;
            const action_time = cfg_section.action_time;

            const section = {
                ID,
                name,
                line,
                begin_nodes: [],
                end_nodes: [],
                pump_nodes: [],
                flow_diff_WH,
                flow_diff_WH_delay,
                flow_diff_AH,
                flow_diff_AH_delay,
                action_time,
            };
            cfg_section.begin_nodes.forEach(node_name => {
                const cfg_node = cfg_actuators[node_name];
                cfg_node.is_begin = true;
                add_actuator(section, cfg_node);
            });
            cfg_section.end_nodes.forEach(node_name => {
                const cfg_node = cfg_actuators[node_name];
                cfg_node.is_end = true;
                add_actuator(section, cfg_node);
            });
            line.sections.push(section);
        }
    }

    return controller;
}
