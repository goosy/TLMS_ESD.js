import { debouncify } from "./util.js";
import { logger } from "./util.js";
import { node_parameters } from "./structs/share.js";

const parameters_tags = node_parameters.map(item => item.name);

export function node_init(actuator) {
    const {
        ID, name, data, command,
        section, is_begin, is_end, has_pumps,
        data_driver, command_driver, driver_info
    } = actuator;
    command.name = `${name}_CMD`;
    data.name = name;
    actuator.debounce_send_commands = debouncify(`SC4RespCodeOrCmdChan_${name}`, () => {
        if (command_driver.is_connected === false) return;
        actuator.commands_payload.write();
    }, 100);
    actuator.reset_parameters = () => {
        actuator.commands_payload.copy_from(data);
    };
    actuator.write_parameters = async () => {
        actuator.data_parameters.copy_from(command);
        return actuator.data_parameters.write();
    };

    if (has_pumps) actuator.update_pump_run = () => {
        data.pump_run = data.pump_run_1 || data.pump_run_2 || data.pump_run_3 || data.pump_run_4;
    }

    const { endian, combined_endian } = driver_info;

    let reset_comm_id;
    data_driver.on("data_error", (e) => {
        setTimeout(() => {
            data.work_OK = false;
        }, data.delay_protect_time);
        logger.debug(`actuator ${name} ${e}`);
    });
    data_driver.on("connfailed", (e) => {
        reset_comm_id = setTimeout(() => {
            data.comm_OK = false;
        }, data.delay_protect_time);
        logger.error(`actuator ${name} connection failed: ${e}`);
    });
    data_driver.on("connect", () => {
        data.comm_OK = true;
        clearTimeout(reset_comm_id);
        // reset parameter
        setTimeout(actuator.reset_parameters, 2000);
    });
    const data_extras = [];
    const commands_extras = [];
    if (driver_info.protocol === 'S7') {
        data_extras.push(driver_info.data.area, driver_info.data.db);
        commands_extras.push(driver_info.commands.area, driver_info.commands.db);
    } else if (driver_info.protocol === 'modbusTCP') {
        data_extras.push(driver_info.data.unit_id);
        commands_extras.push(driver_info.commands.unit_id);
    }


    data.ID = ID;
    const start = 0; // The local buffer start address where data needs to be copied
    data.set_IO(data_driver, {
        remote_start: driver_info.data.start,
        start, length: data.size,
        endian, combined_endian,
    }, ...data_extras);

    actuator.data_payload = data.create_tag_group(
        'ID',
        'status',
        'temperature', 'pressure', 'flowmeter',
        'response_code',
        ...parameters_tags
    );
    actuator.data_parameters = data.create_tag_group(...parameters_tags);

    data.on("change", (tagname, old_value, new_value) => {
        logger.debug(`actuator_${name}_data: ${tagname} ${old_value} => ${new_value}`);
    });

    data.get('response_code').on("change", (_, new_value) => {
        if (new_value) {
            // handle command response_code
            // valid: (handled in PLC)
            //     stop_pumps cancel_stop
            //     enable_pressure_SD disable_pressure_SD
            //     write_paras
            // todo:
            //     horn reset_horn read_paras
            //     enable_pressure_alarm disable_pressure_alarm
            //     enable_temperature_alarm disable_temperature_alarm
            //     reset_CPU reset_conn
            // Reset the corresponding bit in commands according to response_code
            command.commands = ~new_value & command.commands;
            command.executing = false;
            if (data.response_code !== 0) actuator.debounce_send_commands();
        }
    });
    data.get('pressure_SD_F').on("change", (_, new_value) => {
        if (new_value) {
            command.enable_pressure_SD = false;
            logger.info(`actuator ${name} allows pressure interlock`);
        } else {
            command.disable_pressure_SD = false;
            logger.info(`actuator ${name} prohibits pressure interlock`);
        }
        actuator.debounce_send_commands();
    });
    data.get('comm_OK').on("change", (_, new_value) => {
        section.update_comm_OK();
        logger.info(`actuator ${name} communication is ${new_value ? 'normal' : 'lost'}`);
    });
    data.get('work_OK').on("change", (_, new_value) => {
        section.update_work_OK();
        logger.info(`actuator ${name} ${new_value ? 'resumes normal operation' : 'is not working properly'}`);
    });
    if (has_pumps) {
        data.get('pump_run').on("change", (_, new_value) => {
            section.update_pump_run();
            if (!new_value) command.stop_pumps = false;
        });
        data.get('pump_run_1').on("change", (old_value, new_value) => {
            logger.info(`actuator ${name} pump 1 status changed: ${old_value} -> ${new_value}`);
            actuator.update_pump_run();
        });
        data.get('pump_run_2').on("change", (old_value, new_value) => {
            logger.info(`actuator ${name} pump 2 status changed: ${old_value} -> ${new_value}`);
            actuator.update_pump_run();
        });
        data.get('pump_run_3').on("change", (old_value, new_value) => {
            logger.info(`actuator ${name} pump 3 status changed: ${old_value} -> ${new_value}`);
            actuator.update_pump_run();
        });
        data.get('pump_run_4').on("change", (old_value, new_value) => {
            logger.info(`actuator ${name} pump 4 status changed: ${old_value} -> ${new_value}`);
            actuator.update_pump_run();
        });
        data.get('pump_change_F').on("change", (_o, _n) => {
            section.update_pump_change_F();
        });
    }
    data.get('pressure_WH_F').on("change", (old_value, new_value) => {
        logger.info(`actuator ${name} pressure warning status changed: ${old_value} -> ${new_value}`);
        section.update_press_warning_F();
    });
    data.get('pressure_AH_F').on("change", (old_value, new_value) => {
        logger.info(`actuator ${name} pressure alarm status changed: ${old_value} -> ${new_value}`);
        section.update_press_alarm_F();
    });
    data.get('flowmeter').on("change", (_o, _n) => {
        if (is_begin) section.update_flow_begin();
        if (is_end) section.update_flow_end();
    });

    command.ID = ID;
    command.set_IO(command_driver, {
        remote_start: driver_info.commands.start,
        start: 16, length: command.size - 16,
        endian, combined_endian,
    }, ...commands_extras);

    actuator.commands_payload = command.create_tag_group(
        'ID',
        'commands',
        ...parameters_tags,
    );

    command.on("change", (tagname, old_value, new_value) => {
        logger.debug(`actuator_${name}_command: ${tagname} ${old_value} => ${new_value}`);
    });
    command.get('read_paras').on("change", (_, new_value) => {
        if (new_value) {
            actuator.reset_parameters();
            process.nextTick(() => {
                command.read_paras = false;
            });
        }
    });
    command.get('write_paras').on("change", (_, new_value) => {
        if (new_value) {
            actuator.write_parameters().then(() => {
                command.write_paras = false;
            });
        }
    });
    command.get('commands').on("change", (_, new_value) => {
        command.has_commands = new_value > 0;
        actuator.debounce_send_commands();
    });

    // The start() function already handles duplicates automatically if the driver is the same.
    data_driver.start();
    command_driver.start();
}

let no_response_count = 0;

export function node_loop(actuator) {
    const { data, command, data_driver } = actuator;
    if (data_driver.is_connected) {
        // read a node data.
        actuator.data_payload.read();
        // @TODO check the correctness of the ID
        // @delete temporary code
        // because the PLC program is not completed,
        // all commands except stop_pumps enable_pressure_SD disable_pressure_SD and write_paras
        // will reset unconditionally.
        command.commands = command.commands & 0xB1;
    }
    if (command.has_commands === true) no_response_count++;
    else no_response_count = 0;
    if (no_response_count > 3) {
        actuator.debounce_send_commands();
    }
}
