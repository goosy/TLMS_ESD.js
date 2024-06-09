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
    actuators = [],
    controllers = [];
export let work_path = '.';

export async function init() {
    work_path = process.cwd();
    await read_config(work_path);

    for (const cfg_line of cfg_lines) {
        const data = new TData(LINE);
        data.set("line_ID", cfg_line.id);
        attach_to_server(cfg_line.mb_unit_id, data);
        const line = { data };
        lines.push(line);
        line.sections = [];
        for (const cfg_section of cfg_line.sections) {
            const data = new TData(SECTION);
            // tsection.set("section_id", section.id);
            data.set("warning_flow_diff", cfg_section.warning_flow_diff);
            data.set("warning_flow_delay", cfg_section.warning_flow_delay);
            data.set("alarm_flow_diff", cfg_section.alarm_flow_diff);
            data.set("alarm_flow_delay", cfg_section.alarm_flow_delay);
            data.set("action_time", cfg_section.action_time);
            attach_to_server(cfg_section.mb_unit_id, data);
            const section = { data };
            line.sections.push(section);
            sections.push(section);
            section.begin_nodes = [];
            for (const cfg_node of cfg_section.begin_nodes) {
                const data = new TData(NODE);
                data.set("node_ID", cfg_node.id);
                attach_to_server(cfg_node.mb_unit_id, data);
                const conn = new MTClient(cfg_node.IP, cfg_node.modbus_port);
                data.setIO(
                    conn,
                    { start: 0, length: data.size >> 4 }
                );
                const command = new TData(COMMAND);
                command.set("node_ID", cfg_node.id);
                attach_to_server(cfg_node.mb_unit_id, command, 200);

                const actuator = { data, command };
                section.begin_nodes.push(actuator);
                actuators.push(actuator);
            }
            section.end_nodes = [];
            for (const cfg_node of cfg_section.end_nodes) {
                const data = new TData(NODE);
                data.set("node_ID", cfg_node.id);
                attach_to_server(cfg_node.mb_unit_id, data);
                const conn = new MTClient(cfg_node.IP, cfg_node.modbus_port);
                data.setIO(
                    conn,
                    { start: 0, length: data.size >> 4 }
                );
                const command = new TData(COMMAND);
                command.set("node_ID", cfg_node.id);
                attach_to_server(cfg_node.mb_unit_id, command, 200);

                const actuator = { data, command };
                section.end_nodes.push(actuator);
                actuators.push(actuator);
            }
        }
    }
}