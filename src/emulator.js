import { attach_unit, createMTServer } from "./drivers/modbusTCP.js";
import { TData } from "./data_type/TData.js";
import { NODE } from "./data_type/TNode.js";
import { COMMAND } from "./data_type/TCmd.js";
import { read_config, cfg_actuators, MAIN_PERIOD } from "./config.js";
import { debounce, logger } from './util.js';

function loop_actuator(actuator) {
    // host_actuator(actuator);
    const { data, command } = actuator;
    if (command.stop_pumps && data.pump_run) {
        data.pump_run_1 = false;
        data.pump_run_2 = false;
        data.pump_run_3 = false;
        data.pump_run_4 = false;
        data.stop_pumps = true;
    } else {
        data.stop_pumps = false;
    }
    if (actuator.write_paras) {
        const data_para_start = data.groups.paras.start >> 3;
        const cmd_para_start = command.groups.paras.start >> 3;
        const cmd_para_end = command.groups.paras.end >> 3;
        command.buffer.copy(data.buffer, data_para_start, cmd_para_start, cmd_para_end);
        data.check_all_tags();
        data.write_paras = true;
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
        logger.debug(`${name}: ${tagname} ${old_value} => ${new_value}`);
        if (tagname === 'pump_run_1' || tagname === 'pump_run_2' || tagname === 'pump_run_3' || tagname === 'pump_run_4') {
            data.pump_change_F = true;
            data.pump_run = data.pump_run_1 || data.pump_run_2 || data.pump_run_3 || data.pump_run_4;
            debounce(`${name}-${tagname}`, () => {
                data.pump_change_F = false;
            }, data.pump_change_delay);
            return;
        }
        if (tagname === 'commands') {
            if (new_value == 0) data.response_code = 0;
        }
        if (tagname === 'pressure') {
            const pressure_enabled = data.pressure_enabled;
            data.pressure_WH_F = pressure_enabled && (new_value > data.pressure_WH);
            data.pressure_AH_F = pressure_enabled && (new_value > data.pressure_AH);
        }
    });
    data.ID = id;
    data.name = name;
    data.pressure_AH = pressure_AH;
    data.pressure_WH = pressure_WH;
    data.pressure_SD_F = pressure_SD;
    data.comm_OK = true;
    data.work_OK = true;
    data.pressure_enabled = true;
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
        logger.debug(`${name}_CMD: ${tagname} ${old_value} => ${new_value}`);
        if (tagname === 'enable_pressure_SD') {
            if (new_value) {
                data.pressure_SD_F = true;
                data.enable_pressure_SD = true;
            } else {
                data.enable_pressure_SD = false;
            }
            return;
        }
        if (tagname === 'disable_pressure_SD') {
            if (new_value) {
                data.pressure_SD_F = false;
                data.disable_pressure_SD = true;
            } else {
                data.disable_pressure_SD = false;
            }
            return;
        }
        if (tagname === 'write_paras') {
            if (new_value) {
                // When write_paras changes,
                // the relevant parameters may not be ready,
                // so the operation is placed at the next tick.
                actuator.write_paras = true;
            } else {
                data.write_paras = false;
            }
            return;
        }
        if (tagname === 'enable') {
            if (new_value) {
                data.work_OK = true;
                data.enable = true;
            } else {
                data.enable = false;
            }
            return;
        }
        if (tagname === 'disable') {
            if (new_value) {
                data.work_OK = false;
                data.disable = true;
            } else {
                data.disable = false;
            }
            return;
        }
    });
    command.name = name + '_CMD';
}

const unit_map_poll = {};
const actuators = [];

function init_tdata(tdata, mb_info, offset) {
    const unit_id = mb_info.unit_id;
    const port = mb_info.port;
    unit_map_poll[port] ??= {};
    attach_unit(unit_map_poll[port], unit_id, tdata, mb_info.start, offset);
}

function prepare_actuator(name) {
    const cfg_actuator = cfg_actuators[name];
    if (cfg_actuator == undefined) {
        return null;
    }
    const {
        id, pumps,
        pressure_AH,
        pressure_WH,
        pressure_AI,
        temperature_AI,
        pressure_SD = false,
        pressure_WL,
        pressure_AL,
        modbus_server,
    } = cfg_actuator;
    if (modbus_server == undefined) return null;
    const data = new TData(NODE);
    const command = new TData(COMMAND);
    init_tdata(data, modbus_server.data, 0);
    init_tdata(command, modbus_server.commands, 16);

    const has_pumps = pumps != undefined;
    const write_paras = false;
    const actuator = {
        id, name,
        data, command,
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
            logger.info(`actuator: ${name} is ready.`);
        }
    }

    actuators.forEach(actuator => {
        actuator_init(actuator);
    });

    // start modbus TCP server
    for (const [port, unit_map] of Object.entries(unit_map_poll)) {
        const server = createMTServer('0.0.0.0', port, unit_map);
        server.on("close", () => {
            logger.info("connection closed!");
        });
    }

    // main loop
    setInterval(() => {
        actuators.forEach(actuator => loop_actuator(actuator));
    }, MAIN_PERIOD);
}

await read_config(process.cwd());
run(process.argv.slice(2));
