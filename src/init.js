import { MTClient, attach_to_server, createMTServer } from "./drivers/modbusTCP.js";
import { TData } from "./data_type/TData.js";
import { SECTION } from "./data_type/TSection.js";
import { LINE } from "./data_type/TLine.js";
import { NODE } from "./data_type/TNode.js";
import { COMMAND } from "./data_type/TCmd.js";
import { read_config, cfg_lines, cfg_actuators, cfg_controllers } from './config.js';
import { actuator_loop, actuator_init, lines, sections, actuators } from './node_proc.js';
import { section_loop, section_init } from './section_proc.js';

export let work_path = '.';

function add_actuator(section, cfg_node) {
    const unit_id_map = section.line.controller.modbus_server.unit_id;
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
    actuators.push(actuator);
    actuator.section = section;
    if (cfg_node.is_begin) section.begin_nodes.push(actuator);
    if (cfg_node.is_end) section.end_nodes.push(actuator);
    if (cfg_node.has_pumps) section.pump_nodes.push(actuator);
    actuator_init(actuator);
    setInterval(() => actuator_loop(actuator), 1000);
}

export async function init(controller_name) {
    work_path = process.cwd();
    await read_config(work_path);
    const controller = cfg_controllers[controller_name];
    if (!controller) return;
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
            const ID = cfg_section.id;
            const name = cfg_section.name;
            const flow_diff_WH = cfg_section.flow_diff_WH;
            const flow_diff_WH_delay = cfg_section.flow_diff_WH_delay;
            const flow_diff_AH = cfg_section.flow_diff_AH;
            const flow_diff_AH_delay = cfg_section.flow_diff_AH_delay;
            const action_time = cfg_section.action_time;
            attach_to_server(unit_id_map[name], data, 0);

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
            section_init(section);
            line.sections.push(section);
            sections.push(section);
            setInterval(() => section_loop(section), 1000);
        }
    }

    const server = createMTServer('0.0.0.0', controller.modbus_server.port);
    server.on("close", () => {
        console.log("connection closed!");
    });
}