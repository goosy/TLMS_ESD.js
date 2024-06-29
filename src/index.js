import { init, controllers, MAIN_PERIOD } from "./init.js";
import { line_loop, line_init } from "./line_proc.js";
import { section_loop, section_init } from './section_proc.js';
import { node_loop, node_init } from './node_proc.js';
import { MTClient, attach_unit, createMTServer } from "./drivers/modbusTCP.js";

// for run controller
const running_lines = [];
const running_sections = [];
const running_nodes = [];

export async function run(name) {
    await init();
    const controller = controllers[name];
    if (controller) { // run controller
        run_controller(controller);
    }
}

function add_node(node, unit_map) {
    const unit_id = node.modbus_server.unit_id; // for actuator side
    const data_driver = new MTClient(node.modbus_server.IP, node.modbus_server.port, { unit_id });
    node.data_driver = data_driver;
    data_driver.on("connect", () => {
        console.log(`ModbusTCP connected to ${node.name}: ${data_driver.conn_str}!`);
    });
    // for controller side, do not use `node.modbus_server.unit_id;`
    const s_unit_id = node.section.line.controller.modbus_server.unit_id[node.name];
    const data = node.data;
    attach_unit(unit_map, s_unit_id, data, 0);
    const command = node.command;
    attach_unit(unit_map, s_unit_id, command, 400);

    node_init(node);
    running_nodes.push(node);
}

function run_controller(controller) {
    const unit_id_map = controller.modbus_server.unit_id;
    const unit_map = {};

    for (const line of controller.lines) {
        const data = line.data;
        const name = line.name;
        attach_unit(unit_map, unit_id_map[name], data, 0);
        line_init(line);
        running_lines.push(line);
        for (const section of line.sections) {
            const data = section.data;
            const name = section.name;
            attach_unit(unit_map, unit_id_map[name], data, 0);
            [...section.begin_nodes, ...section.end_nodes].forEach(node => {
                add_node(node, unit_map);
            });
            section_init(section);
            running_sections.push(section);
        }
    }

    // start modbus TCP server
    const server = createMTServer('0.0.0.0', controller.modbus_server.port, unit_map);
    server.on("close", () => {
        console.log("connection closed!");
    });

    // main loop
    setInterval(() => {
        running_lines.forEach(line => line_loop(line));
        running_sections.forEach(section => section_loop(section));
        running_nodes.forEach(node => node_loop(node));
    }, MAIN_PERIOD);
}
