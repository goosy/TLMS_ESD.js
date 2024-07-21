import { readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import { GCL } from './gcl.js';
import { logger } from './util.js';

export const MAIN_PERIOD = 500;
export const cfg_lines = [],
    cfg_sections = [],
    cfg_actuators = [],
    cfg_controllers = [];

function add_conf(doc) {
    const {
        lines: _lines = [],
        sections: _sections = [],
        actuators: _actuators = [],
        controllers: _controllers = [],
    } = doc;

    for (const _controller of _controllers) {
        const controller = { ..._controller };
        cfg_controllers[controller.name] = controller;
        cfg_controllers.push(controller);
    }
    for (const _actuator of _actuators) {
        const actuator = { ..._actuator };
        if(typeof actuator.id !== "number" || actuator.id === 0){
            logger.error(`node:${actuator.name} ID 必须是一个非零数字`);
            process.exit(1);
        }

        const pumps = actuator.pumps;
        if (pumps) {
            pumps.forEach((pumpstr, i) => {
                const [run_state, stop_signal] = pumpstr.split(',', 2).map(str => str.trim());
                pumps[i] = { run_state, stop_signal };
            });
            actuator.has_pumps = true;
        }

        const modbus_server = actuator.modbus_server;
        const s7_server = actuator.s7_server;
        if (modbus_server) {
            const port = modbus_server.port ?? 502;
            const unit_id = modbus_server.unit_id ?? 1;
            const start = modbus_server.start ?? 0;
            const length = modbus_server.length;
            const endian = modbus_server.endian ?? 'big';
            const combined_endian = modbus_server.combined_endian ?? 'little';

            const data = modbus_server.data ?? {};
            data.port ??= port;
            data.unit_id ??= unit_id;
            data.start ??= start;
            data.length ??= length;
            const commands = modbus_server.commands ?? {};
            commands.port ??= port;
            commands.unit_id ??= unit_id;
            commands.start ??= start;
            commands.length ??= length;
            actuator.modbus_server = { data, commands, endian, combined_endian };
        } else if (s7_server) {
            const port = s7_server.port ?? 102;
            const rack = s7_server.rack ?? 0;
            const slot = s7_server.slot ?? 0;
            const area = s7_server.area ?? 'DB';
            const db = s7_server.db ?? 10;
            const start = s7_server.start ?? 0;
            const length = s7_server.length;
            const endian = s7_server.endian ?? 'big';
            const combined_endian = s7_server.combined_endian ?? 'little';

            const data = s7_server.data ?? {};
            data.area ??= area;
            data.db ??= db;
            data.start ??= start;
            data.length ??= length;
            const commands = s7_server.commands ?? {};
            commands.area ??= area;
            commands.db ??= db;
            commands.start ??= start;
            commands.length ??= length;
            actuator.s7_server = { port, rack, slot, data, commands, endian, combined_endian };
        }


        actuator.pressure_AH ??= actuator.pressure_span;
        actuator.pressure_WH ??= actuator.pressure_span;
        actuator.pressure_WL ??= actuator.pressure_zero;
        actuator.pressure_AL ??= actuator.pressure_zero;
        actuator.temperature_AH ??= actuator.temperature_span;
        actuator.temperature_WH ??= actuator.temperature_span;
        actuator.temperature_WL ??= actuator.temperature_zero;
        actuator.temperature_AL ??= actuator.temperature_zero;
        cfg_actuators[actuator.name] = actuator;
        cfg_actuators['ID' + actuator.id] = actuator;
        cfg_actuators.push(actuator);
    }
    for (const _section of _sections) {
        const section = { ..._section }
        const name = section.name;
        const ID = section.id;
        cfg_sections[name] = section;
        cfg_sections['ID' + ID] = section;
        cfg_sections.push(section);
    }
    for (const _line of _lines) {
        const name = _line.name;
        const ID = _line.id;
        cfg_lines[name] = _line;
        cfg_lines['ID' + ID] = _line;
        cfg_lines.push(_line);
    }
}


export async function read_config(work_path) {
    const docs = [];
    for (const file of await readdir(work_path)) {
        if (/^.*\.ya?ml$/i.test(file)) {
            const filename = posix.join(work_path, file);
            const gcl = new GCL();
            await gcl.load(filename);
            logger.info(`read ${filename}`);

            const doc = gcl.document.toJS();
            docs.push(doc);
        }
    }
    docs.forEach(add_conf);

    for (const line of cfg_lines) {
        const c_name = line.controller;
        const controller = cfg_controllers[c_name];
        controller.lines ??= [];
        controller.lines.push(line);
        line.controller = controller;

        line.sections = line.sections.map(name => {
            const section = cfg_sections[name];
            section.line = line;
            return section;
        });
    }
}