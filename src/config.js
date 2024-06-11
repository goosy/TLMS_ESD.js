import assert from 'assert/strict';
import { readdir } from 'fs/promises';
import { posix } from 'path';
import { GCL } from './gcl.js';

export const cfg_lines = [],
    cfg_sections = [],
    cfg_actuators = [],
    cfg_connections = {},
    cfg_controllers = [];

const controllers = {};

function add_conf(doc) {
    const {
        lines: _lines = [],
        sections: _sections = [],
        actuators: _actuators = [],
        controllers: _controllers = [],
    } = doc;

    for (const _controller of _controllers) {
        const controller = { ..._controller };
        controllers[controller.name] = controller;
        const conns = controller.connections;
        cfg_connections[controller.name] = conns;
        const local_ip = controller.IP.split('.');
        for (const conn of conns) {
            const default_name = `${controller.name}_${conn.id}`;
            cfg_connections[default_name] = conn;
            conn.name ??= default_name;
            conn.local_ip = local_ip;
        }
    }
    for (const _actuator of _actuators) {
        const actuator = { ..._actuator };
        assert(typeof actuator.id === "number" && actuator.ID !== 0, `node:${actuator.name} ID 必须是一个非零数字`);

        const pumps = actuator.pumps;
        if (pumps) {
            pumps.forEach((pumpstr, i) => {
                const [run_state, stop_signal] = pumpstr.split(',', 2).map(str => str.trim());
                pumps[i] = { run_state, stop_signal };
            });
        }

        actuator.pressure_AH ??= actuator.pressure_span;
        actuator.pressure_WH ??= actuator.pressure_span;
        actuator.pressure_WL ??= actuator.pressure_zero;
        actuator.pressure_AL ??= actuator.pressure_zero;
        actuator.temperature_AH ??= actuator.temperature_span;
        actuator.temperature_WH ??= actuator.temperature_span;
        actuator.temperature_WL ??= actuator.temperature_zero;
        actuator.temperature_AL ??= actuator.temperature_zero;
        const conns = actuator.connections;
        cfg_connections[actuator.name] = conns;
        const local_ip = actuator.IP.split('.');
        for (const conn of conns) {
            const default_name = `${actuator.name}_${conn.id}`;
            cfg_connections[default_name] = conn;
            conn.name ??= default_name;
            conn.send_data ??= '"node_data"';
            conn.recv_data ??= '"commands"';
            conn.local_ip = local_ip;
        }
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
            console.log(`read ${filename}`);

            const doc = gcl.document.toJS();
            docs.push(doc);
        }
    }
    docs.forEach(add_conf);

    for (const actuator of cfg_actuators) {
        for (const conn of actuator.connections) {
            if (conn.remote) {
                const rconn = cfg_connections[conn.remote + '_' + conn.remote_id];
                conn.remote_ip = rconn.local_ip;
                conn.remote_tsap_id = rconn.port;
            }
        }
    }
    for (const section of cfg_sections) {
        section.begin_nodes = section.begin_nodes.map(node_name => cfg_actuators[node_name]);
        section.end_nodes = section.end_nodes.map(node_name => cfg_actuators[node_name]);
        section.nodes = [...section.begin_nodes, ...section.end_nodes];
        section.nodes.forEach(node => node.section = section);
    }
    for (const line of cfg_lines) {
        const c_name = line.controller;
        const controller = controllers[c_name];
        controller.lines ??= [];
        controller.lines.push(line);
        line.controller = controller;
        cfg_controllers[c_name] = controller;
        cfg_controllers.push(controller);

        line.sections = line.sections.map(name => {
            const section = cfg_sections[name];
            section.line = line;
            return section;
        });
    }
}