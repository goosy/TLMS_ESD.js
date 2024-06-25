import { TData } from "./data_type/TData.js";
import { SECTION } from "./data_type/TSection.js";
import { LINE } from "./data_type/TLine.js";
import { NODE } from "./data_type/TNode.js";
import { COMMAND } from "./data_type/TCmd.js";
import { cfg_lines, cfg_actuators, cfg_controllers } from "./config.js";
export const MAIN_PERIOD = 500;
export const
    lines = [],
    sections = [],
    actuators = [],
    controllers = [];

export let work_path = '.';

function add_actuator(section, cfg_node) {
    const ID = cfg_node.id;
    const name = cfg_node.name;
    const IP = cfg_node.IP;
    const modbus_server = { IP, ...cfg_node.modbus_server };
    const data = new TData(NODE);
    const command = new TData(COMMAND);

    const actuator = { ID, name, data, command, modbus_server, section };
    actuators.push(actuator);
    actuators[name] = actuator;
    if (cfg_node.is_begin) section.begin_nodes.push(actuator);
    if (cfg_node.is_end) section.end_nodes.push(actuator);
    if (cfg_node.has_pumps) section.pump_nodes.push(actuator);
}

export async function init() {
    cfg_controllers.forEach(_controller => {
        const controller = { ..._controller, lines: [] };
        controllers[_controller.name] = controller;
        controllers.push(controller);
    })
    for (const cfg_line of cfg_lines) {
        const controller = controllers[cfg_line.controller.name];
        const data = new TData(LINE);
        const ID = cfg_line.id;
        const name = cfg_line.name;
        const line = { ID, name, data, controller, sections: [] };
        lines.push(line);
        controller.lines.push(line);
        for (const cfg_section of cfg_line.sections) {
            const data = new TData(SECTION);
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
                data,
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
            sections.push(section);
        }
    }
}
