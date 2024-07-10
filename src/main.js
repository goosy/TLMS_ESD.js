import { init, controllers, MAIN_PERIOD } from "./init.js";
import { read_config } from "./config.js";
import { line_loop, line_init } from "./line_proc.js";
import { section_loop, section_init } from './section_proc.js';
import { node_loop, node_init } from './node_proc.js';
import { Action_Record } from "./action_record.js";
import { MTClient, attach_unit, createMTServer } from "./drivers/modbusTCP.js";
import { S7Client } from "./drivers/s7.js";
import { logger } from './util.js';

// for run controller
const running_lines = [];
const running_sections = [];
const running_nodes = [];
const modbusTCP_clients = {};
const S7_clients = {};

function get_modbusTCP_client(IP, port, unit_id) {
    const key = `${IP}:${port} ${unit_id}`;
    if (key in modbusTCP_clients) return modbusTCP_clients[key];
    const driver = new MTClient(IP, port, { unit_id });
    modbusTCP_clients[key] = driver;
    driver.on("connect", () => {
        logger.info(`connected to ${driver.conn_str}!`);
    });
    return driver;
}
function get_s7_client(IP, port, rack, slot) {
    const key = `${IP}:${port} ${rack} ${slot}`;
    if (key in S7_clients) return S7_clients[key];
    const driver = new S7Client({ host: IP, port, rack, slot });
    S7_clients[key] = driver;
    driver.on("connect", () => {
        logger.info(`connected to ${driver.conn_str}!`);
    });
    return driver;
}

await read_config(process.cwd());
await init();
const controller = controllers[process.argv[2]];
if (controller) { // run controller
    run_controller(controller);
}

function add_node(node, unit_map) {
    const driver_info = node.driver_info;
    let data_driver = null;
    let command_driver = null;
    // for actuator side
    if (driver_info.protocol === 'modbusTCP') {
        const data = driver_info.data;
        data_driver = get_modbusTCP_client(driver_info.IP, data.port, data.unit_id);
        const commands = driver_info.commands;
        command_driver = get_modbusTCP_client(driver_info.IP, commands.port, commands.unit_id);
    } else if (driver_info.protocol === 'S7') {
        const { port, host, rack, slot } = driver_info;
        data_driver = command_driver = get_s7_client(host, port, rack, slot);
    }
    node.data_driver = data_driver;
    node.command_driver = command_driver;

    // for controller side, do not use `node.driver_info.unit_id;`
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

    // action records
    const name = 'action_records';
    const action_record = new Action_Record(name);
    action_record.init();
    attach_unit(unit_map, unit_id_map[name], action_record.data, 0);
    controller.action_record = action_record;

    for (const line of controller.lines) { // lines
        const data = line.data;
        const name = line.name;
        attach_unit(unit_map, unit_id_map[name], data, 0);
        line_init(line);
        running_lines.push(line);
        for (const section of line.sections) { // sections
            const data = section.data;
            const name = section.name;
            attach_unit(unit_map, unit_id_map[name], data, 0);
            [...section.begin_nodes, ...section.end_nodes].forEach(node => { // nodes
                add_node(node, unit_map);
            });
            section_init(section);
            running_sections.push(section);
        }
    }

    // start modbus TCP server
    const server = createMTServer('0.0.0.0', controller.modbus_server.port, unit_map);
    server.on("close", () => {
        logger.error("connection closed!");
    });

    // main loop
    setInterval(() => {
        running_lines.forEach(line => line_loop(line));
        running_sections.forEach(section => section_loop(section));
        running_nodes.forEach(node => node_loop(node));
    }, MAIN_PERIOD);
}
