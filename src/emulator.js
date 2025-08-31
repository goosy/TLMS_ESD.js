import { Unit_Map, createMTServer } from "./drivers/modbusTCP.js";
import { TData } from "./typed_data/TData.js";
import { NODE } from "./structs/node.js";
import { COMMAND } from "./structs/command.js";
import { node_parameters } from "./structs/share.js";
import { read_config, cfg_actuators, MAIN_PERIOD } from "./config.js";
import { debounce, logger } from './util.js';

logger.category = 'console';
const parameters_tags = node_parameters.map(item => item.name);

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
    actuator.data_parameters = data.create_tag_group(...parameters_tags);

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
    });
    data.get('pressure').on("change", (_, new_value) => {
        const pressure_enabled = data.pressure_enabled;
        data.pressure_WH_F = pressure_enabled && (new_value > data.pressure_WH);
        data.pressure_AH_F = pressure_enabled && (new_value > data.pressure_AH);
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
    data.delay_protect_time = 2000;
    data.flow_smooth_factor = 0.9;
    data.equS1 = 10000;
    data.equS2 = 10000;
    data.equS3 = 10000;
    data.equS4 = 10000;
    data.equS5 = 10000;
    data.pump_change_delay = 20000;

    command.on("change", (tagname, old_value, new_value) => {
        logger.debug(`${name}_CMD: ${tagname} ${old_value} => ${new_value}`);
    });
    command.get('commands').on("change", (_, new_value) => {
        if (new_value === 0) data.response_code = 0;
    });
    command.get('enable_pressure_SD').on("change", (_, new_value) => {
        if (new_value) {
            data.pressure_SD_F = true;
            data.enable_pressure_SD = true;
        } else {
            data.enable_pressure_SD = false;
        }
    });
    command.get('disable_pressure_SD').on("change", (_, new_value) => {
        if (new_value) {
            data.pressure_SD_F = false;
            data.disable_pressure_SD = true;
        } else {
            data.disable_pressure_SD = false;
        }
    });
    command.get('write_paras').on("change", (_, new_value) => {
        data.write_paras = new_value;
    });
    command.get('enable').on("change", (_, new_value) => {
        if (new_value) {
            data.work_OK = true;
            data.enable = true;
        } else {
            data.enable = false;
        }
    });
    command.get('disable').on("change", (_, new_value) => {
        if (new_value) {
            data.work_OK = false;
            data.disable = true;
        } else {
            data.disable = false;
        }
    });
    command.name = `${name}_CMD`;
}

const unit_map_list = new Map();
const actuators = [];

function init_tdata(tdata, mb_info, offset) {
    const unit_id = mb_info.unit_id;
    const start = mb_info.start;
    const port = mb_info.port;
    if (!unit_map_list.has(port)) unit_map_list.set(port, new Unit_Map());
    unit_map_list.get(port).attach_unit(unit_id, tdata, start, offset);
    tdata.set_IO(null, { start: offset, length: tdata.size - offset });  // emulator don't need IO
}

function prepare_actuator(name) {
    const cfg_actuator = cfg_actuators[name];
    if (cfg_actuator == null) {
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
        driver_info,
    } = cfg_actuator;
    if (driver_info.protocol !== 'modbusTCP') return null;
    const data = new TData(NODE);
    const command = new TData(COMMAND);
    init_tdata(data, driver_info.data, 0);
    init_tdata(command, driver_info.commands, 16);

    const has_pumps = pumps != null;
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

    for (const actuator of actuators) {
        actuator_init(actuator);
    }

    // start modbus TCP server
    for (const [port, unit_map] of unit_map_list) {
        createMTServer('0.0.0.0', port, unit_map).start();
    }

    // main loop
    setInterval(() => {
        for (const actuator of actuators) {
            loop_actuator(actuator);
        }
    }, MAIN_PERIOD);
}

await read_config(process.cwd());
run(process.argv.slice(2));
