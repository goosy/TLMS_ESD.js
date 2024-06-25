import { attach_unit, createMTServer } from "./drivers/modbusTCP.js";
import { MAIN_PERIOD } from "./init.js";
import { TData } from "./data_type/TData.js";
import { NODE } from "./data_type/TNode.js";
import { COMMAND } from "./data_type/TCmd.js";
import { read_config, cfg_actuators } from "./config.js";
import { debounce, curr_time } from "./util.js";

function loop_actuator(actuator) {
    // host_actuator(actuator);
    const { data, command } = actuator;
    if (command.stop_pumps && data.pump_run) {
        data.pump_run_1 = false;
        data.pump_run_2 = false;
        data.pump_run_3 = false;
        data.pump_run_4 = false;
        data.response_code |= 0x1;
    } else {
        data.response_code &= 0xfffe;
    }
    if (actuator.write_paras) {
        const data_para_start = data.groups.paras.start >> 3;
        const cmd_para_start = command.groups.paras.start >> 3;
        const cmd_para_end = command.groups.paras.end >> 3;
        command.buffer.copy(data.buffer, data_para_start, cmd_para_start, cmd_para_end);
        data.check_all_tags();
        data.response_code |= 0x80;
        actuator.write_paras = false;
    }
}

function actuator_init(actuator) {
    const {
        id, name,
        data, command,
        pressure_AH,
        pressure_WH,
        pressure_SD,
    } = actuator;
    data.on('change', (tagname, old_value, new_value) => {
        console.log(`${curr_time()} ${name}: ${tagname} ${old_value} => ${new_value}`); // @debug
        if (tagname === 'pump_run_1' || tagname === 'pump_run_2' || tagname === 'pump_run_3' || tagname === 'pump_run_4') {
            data.pump_change_F = true;
            data.pump_run = data.pump_run_1 || data.pump_run_2 || data.pump_run_3 || data.pump_run_4;
            debounce(`${name}-${tagname}`, () => {
                data.pump_change_F = false;
            }, data.pump_change_delay);
            return;
        }
        if (tagname === 'command_word') {
            if (new_value == 0) data.response_code = 0;
        }
        if (tagname === 'pressure') {
            const enable_pressure_alarm = data.enable_pressure_alarm;
            data.pressure_WH_F = enable_pressure_alarm && (new_value > data.pressure_WH);
            data.pressure_AH_F = enable_pressure_alarm && (new_value > data.pressure_AH);
        }
    });
    data.ID = id;
    data.name = name;
    data.pressure_AH = pressure_AH;
    data.pressure_WH = pressure_WH;
    data.pressure_SD_F = pressure_SD;
    data.comm_OK = true;
    data.work_OK = true;
    data.enable_pressure_alarm = true;
    data.temperature_zero_raw = 0;
    data.temperature_span_raw = 27648;
    data.temperature_underflow = -500;
    data.temperature_overflow = 28000;
    data.temperature_zero = 0;
    data.temperature_span = 100.0;
    data.pressure_zero_raw = 0;
    data.pressure_span_raw = 27648;
    data.pressure_underflow = -500;
    data.pressure_overflow = 28000;
    data.pressure_zero = 0;
    data.pressure_span = 4;
    data.flow_smooth_factor = 0.9;
    data.equS1 = 10000;
    data.equS2 = 10000;
    data.equS3 = 10000;
    data.equS4 = 10000;
    data.equS5 = 10000;
    data.pump_change_delay = 20000;

    command.on("change", (tagname, old_value, new_value) => {
        console.log(`${curr_time()} ${name}_CMD: ${tagname} ${old_value} => ${new_value}`); // @debug
        if (tagname === 'enable_pressure_SD') {
            if (new_value) {
                data.pressure_SD_F = true;
                data.response_code |= 0x10;
            } else {
                data.response_code &= 0xFFEF;
            }
            return;
        }
        if (tagname === 'disable_pressure_SD') {
            if (new_value) {
                data.pressure_SD_F = false;
                data.response_code |= 0x20;
            } else {
                data.response_code &= 0xFFDF;
            }
            return;
        }
        if (tagname === 'write_paras') {
            if (new_value) {
                // When write_paras changes,
                // the relevant parameters may not be ready,
                // so the copy operation is placed at the next tick.
                actuator.write_paras = true;
            } else {
                data.response_code &= 0xFF7F;
            }
            return;
        }
        if (tagname === 'enable') {
            if (new_value) {
                data.work_OK = true;
                data.response_code |= 0x400;
            } else {
                data.response_code &= 0xFBFF;
            }
            return;
        }
        if (tagname === 'disable') {
            if (new_value) {
                data.work_OK = false;
                data.response_code |= 0x800;
            } else {
                data.response_code &= 0xF7FF;
            }
            return;
        }
    });
    command.name = name + '_CMD';
}

const unit_map_poll = {};
const actuators = [];

function prepare_actuator(name) {
    const cfg_actuator = cfg_actuators[name];
    if (cfg_actuator == undefined) {
        return null;
    }
    const {
        id, IP, pumps,
        pressure_AH,
        pressure_WH,
        pressure_AI,
        temperature_AI,
        pressure_SD = false,
        pressure_WL,
        pressure_AL,
        modbus_server,
    } = cfg_actuator;
    const unit_id = modbus_server.unit_id;
    const port = modbus_server.port;
    unit_map_poll[port] ??= {};
    const unit_map = unit_map_poll[port];

    const has_pumps = pumps != undefined;
    let write_paras = false;
    const data = new TData(NODE);
    attach_unit(unit_map, unit_id, data, 0);
    const command = new TData(COMMAND);
    attach_unit(unit_map, unit_id, command, 200 - 16);
    const actuator = {
        id, name,
        data, command,
        IP, port, unit_id, unit_map,
        has_pumps, write_paras,
        pressure_AH,
        pressure_WH,
        pressure_AI,
        temperature_AI,
        pressure_SD,
        pressure_WL,
        pressure_AL,
    };

    actuators.push(actuator);
    actuators[name] = actuator;
    return actuator;
}

export async function run(running_actuator_names) {
    for (const name of running_actuator_names) {
        if (prepare_actuator(name)) {
            console.log(`actuator: ${name} is ready.`);
        }
    }

    actuators.forEach(actuator => {
        actuator_init(actuator);
    });

    // start modbus TCP server
    for (const [port, unit_map] of Object.entries(unit_map_poll)) {
        // console.log(port); //@debug
        // console.log(unit_map); //@debug
        const server = createMTServer('0.0.0.0', port, unit_map);
        server.on("close", () => {
            console.log("connection closed!");
        });
    }

    // main loop
    setInterval(() => {
        actuators.forEach(actuator => loop_actuator(actuator));
    }, MAIN_PERIOD);
}

await read_config(process.cwd());
run(process.argv.slice(2));
