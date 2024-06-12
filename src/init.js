import { MTClient, attach_to_server } from "./drivers/modbusTCP.js";
import { TData } from "./data_type/TData.js";
import { SECTION } from "./data_type/TSection.js";
import { LINE } from "./data_type/TLine.js";
import { NODE } from "./data_type/TNode.js";
import { COMMAND } from "./data_type/TCmd.js";
import { read_config, cfg_lines } from './config.js';

export const
    lines = [],
    sections = [],
    actuators = [];
export let work_path = '.';

function gen_actuators(cfg_nodes) {
    const nodes = [];
    for (const cfg_node of cfg_nodes) {
        const data = new TData(NODE);
        data.set("node_ID", cfg_node.id);
        data.name = cfg_node.name;
        attach_to_server(cfg_node.mb_unit_id, data);
        const data_driver = new MTClient(cfg_node.IP, cfg_node.modbus_port);
        data.setIO(data_driver, {
            start: 0,
            length: data.size,
            pollable: true,
            writewritable: false,
        });
        const command = new TData(COMMAND);
        command.set("node_ID", cfg_node.id);
        command.name = cfg_node.name + '_CMD';
        attach_to_server(cfg_node.mb_unit_id, command, 400);
        command.setIO(data_driver, {
            start: 200,
            length: command.size,
            pollable: false,
            writewritable: false,
        });

        const actuator = { data, command, data_driver };
        nodes.push(actuator);
        actuators.push(actuator);
    }
    return nodes;
}

export async function init() {
    work_path = process.cwd();
    await read_config(work_path);

    for (const cfg_line of cfg_lines) {
        const data = new TData(LINE);
        data.set("line_ID", cfg_line.id);
        data.name = cfg_line.name;
        attach_to_server(cfg_line.mb_unit_id, data);
        const line = { data };
        lines.push(line);
        line.sections = [];
        for (const cfg_section of cfg_line.sections) {
            const data = new TData(SECTION);
            data.set("section_ID", cfg_section.id);
            data.name = cfg_section.name;
            data.set("warning_flow_diff", cfg_section.warning_flow_diff);
            data.set("warning_flow_delay", cfg_section.warning_flow_delay);
            data.set("alarm_flow_diff", cfg_section.alarm_flow_diff);
            data.set("alarm_flow_delay", cfg_section.alarm_flow_delay);
            data.set("action_time", cfg_section.action_time);
            attach_to_server(cfg_section.mb_unit_id, data);
            const section = { data };
            line.sections.push(section);
            sections.push(section);
            section.begin_nodes = gen_actuators(cfg_section.begin_nodes);
            section.end_nodes = gen_actuators(cfg_section.end_nodes);
        }
    }
}