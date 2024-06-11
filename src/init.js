import { MTClient, attach_to_server, createMTServer } from "./drivers/modbusTCP.js";
import { TData } from "./data_type/TData.js";
import { SECTION } from "./data_type/TSection.js";
import { LINE } from "./data_type/TLine.js";
import { NODE } from "./data_type/TNode.js";
import { COMMAND } from "./data_type/TCmd.js";
import { read_config, cfg_lines, cfg_controllers } from './config.js';
import { actuator_loop, actuator_init, lines, sections, actuators } from './automation.js';

export let work_path = '.';

function gen_actuators(section, cfg_nodes) {
    const unit_id_map = section.line.controller.modbus_server.unit_id;
    const nodes = [];
    for (const cfg_node of cfg_nodes) {
        const ID = cfg_node.id;
        const name = cfg_node.name;
        const port = cfg_node.connections[0].port;
        const data_driver = new MTClient(cfg_node.IP, port);
        const unit_id = unit_id_map[name];
        const data = new TData(NODE);
        attach_to_server(unit_id, data, 0);
        const command = new TData(COMMAND);
        attach_to_server(unit_id, command, 400);

        const actuator = { ID, name, data, command, data_driver, unit_id };
        nodes.push(actuator);
        actuators.push(actuator);
        actuator.section = section;
        actuator_init(actuator);
        setInterval(() => actuator_loop(actuator), 1000);
    }
    return nodes;
}

export async function init(controller_name) {
    work_path = process.cwd();
    await read_config(work_path);
    const controller = cfg_controllers[controller_name];
    if(!controller) return;
    const unit_id_map = controller.modbus_server.unit_id;

    for (const cfg_line of cfg_lines) {
        const line_controller = cfg_line.controller;
        if (controller !== line_controller) {
            continue; // Only run the specified controller
        }
        const data = new TData(LINE);
        data.set("ID", cfg_line.id);
        data.name = cfg_line.name;
        attach_to_server(unit_id_map[data.name], data);
        const line = { data, controller };
        lines.push(line);
        line.sections = [];
        for (const cfg_section of cfg_line.sections) {
            const data = new TData(SECTION);
            data.set("ID", cfg_section.id);
            data.name = cfg_section.name;
            data.set("warning_flow_diff", cfg_section.warning_flow_diff);
            data.set("warning_flow_delay", cfg_section.warning_flow_delay);
            data.set("alarm_flow_diff", cfg_section.alarm_flow_diff);
            data.set("alarm_flow_delay", cfg_section.alarm_flow_delay);
            data.set("action_time", cfg_section.action_time);
            attach_to_server(unit_id_map[data.name], data);
            const section = { data, line };
            line.sections.push(section);
            sections.push(section);
            section.begin_nodes = gen_actuators(section, cfg_section.begin_nodes);
            section.end_nodes = gen_actuators(section, cfg_section.end_nodes);
        }
    }

    const server = createMTServer('0.0.0.0', controller.modbus_server.port);
    server.on("close", () => {
        console.log("connection closed!");
    });
}