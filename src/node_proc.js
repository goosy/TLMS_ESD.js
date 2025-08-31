import { debouncify } from "./util.js";
import { logger } from "./util.js";

export function node_init(actuator) {
    const {
        ID, name, data, command,
        section, is_begin, is_end,
        data_driver, command_driver, driver_info
    } = actuator;
    command.name = name + '_CMD';
    data.name = name;
    actuator.debounce_send_commands = debouncify(`SC4RespCodeOrCmdChan_${name}`, () => {
        if (command_driver.is_connected === false) return;
        actuator.commands_payload.write();
    }, 100);
    actuator.reset_parameter = () => {
        const cmd_para_start = command.groups.paras.start >> 3;
        const data_para_start = data.groups.paras.start >> 3;
        const data_para_end = data.groups.paras.end >> 3;
        data.buffer.copy(command.buffer, cmd_para_start, data_para_start, data_para_end);
        command.check_all_tags();
        command.ID = ID;
    };

    const { endian, combined_endian } = driver_info;

    let reset_comm_id;
    data_driver.on("data_error", () => {
        setTimeout(() => {
            data.work_OK = false;
        }, data.delay_protect_time);
    });
    data_driver.on("connect", () => {
        data.comm_OK = true;
        clearTimeout(reset_comm_id);
        // reset parameter
        setTimeout(actuator.reset_parameter, 2000);
    });
    data_driver.on("connfailed", () => {
        reset_comm_id = setTimeout(() => {
            data.comm_OK = false;
        }, data.delay_protect_time);
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

    const data_payload = data.create_tag_group();
    data_payload.add(
        'ID',
        'status',
        'temperature', 'pressure', 'flowmeter',
        'response_code',
        'temperature_zero_raw', 'temperature_span_raw', 'temperature_underflow', 'temperature_overflow',
        'temperature_zero', 'temperature_span',
        'temperature_AH', 'temperature_WH', 'temperature_WL', 'temperature_AL',
        'temperature_DZ', 'temperature_FT',
        'pressure_zero_raw', 'pressure_span_raw', 'pressure_underflow', 'pressure_overflow',
        'pressure_zero', 'pressure_span',
        'pressure_AH', 'pressure_WH', 'pressure_WL', 'pressure_AL',
        'pressure_DZ', 'pressure_FT',
        'delay_protect_time',
        'flow_smooth_factor',
        'equS1', 'equS2', 'equS3', 'equS4', 'equS5',
        'pump_change_delay',
    );
    actuator.data_payload = data_payload;

    data.on("change", (tagname, old_value, new_value) => {
        logger.debug(`actuator_${name}_data: ${tagname} ${old_value} => ${new_value}`);
        if (tagname === 'response_code' && new_value) {
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
            return;
        }
        if (tagname === 'pressure_SD_F') {
            if (new_value) {
                command.enable_pressure_SD = false;
                logger.info(`actuator ${name} allows pressure interlock`);
            } else {
                command.disable_pressure_SD = false;
                logger.info(`actuator ${name} prohibits pressure interlock`);
            }
            actuator.debounce_send_commands();
            return;
        }
        if (tagname === 'comm_OK') {
            section.update_comm_OK();
            logger.info(`actuator ${name} communication is ${new_value ? 'normal' : 'lost'}`);
            return;
        }
        if (tagname === 'work_OK') {
            section.update_work_OK();
            logger.info(`actuator ${name} ${new_value ? 'resumes normal operation' : 'is not working properly'}`);
            return;
        }
        if (tagname === 'pump_run') {
            section.update_pump_run();
            if (!new_value) command.stop_pumps = false;
            return;
        }
        if (['pump_run_1', 'pump_run_2', 'pump_run_3', 'pump_run_4'].includes(tagname)) {
            logger.info(`actuator ${name} pumps status changed: ${tagname}: ${old_value} -> ${new_value}`);
            data.pump_run = data.pump_run_1 || data.pump_run_2 || data.pump_run_3 || data.pump_run_4;
            return;
        }
        if (tagname === 'pump_change_F') {
            section.update_pump_change_F();
            return;
        }
        if (tagname === 'pressure_WH_F') {
            logger.info(`actuator ${name} pressure warning status changed: ${tagname}: ${old_value} -> ${new_value}`);
            section.update_press_warning_F();
            return;
        }
        if (tagname === 'pressure_AH_F') {
            logger.info(`actuator ${name} pressure alarm status changed: ${tagname}: ${old_value} -> ${new_value}`);
            section.update_press_alarm_F();
            return;
        }
        if (tagname === 'flowmeter') {
            if (is_begin) section.update_flow_begin();
            if (is_end) section.update_flow_end();
            return;
        }
    });

    command.ID = ID;
    command.set_IO(command_driver, {
        remote_start: driver_info.commands.start,
        start: 16, length: command.size - 16,
        endian, combined_endian,
    }, ...commands_extras);

    const commands_payload = command.create_tag_group();
    commands_payload.add(
        'ID',
        'commands',
        'temperature_zero_raw', 'temperature_span_raw', 'temperature_underflow', 'temperature_overflow',
        'temperature_zero', 'temperature_span',
        'temperature_AH', 'temperature_WH', 'temperature_WL', 'temperature_AL',
        'temperature_DZ', 'temperature_FT',
        'pressure_zero_raw', 'pressure_span_raw', 'pressure_underflow', 'pressure_overflow',
        'pressure_zero', 'pressure_span',
        'pressure_AH', 'pressure_WH', 'pressure_WL', 'pressure_AL',
        'pressure_DZ', 'pressure_FT',
        'delay_protect_time',
        'flow_smooth_factor',
        'equS1', 'equS2', 'equS3', 'equS4', 'equS5',
        'pump_change_delay',
    );
    actuator.commands_payload = commands_payload;

    command.on("change", (tagname, old_value, new_value) => {
        logger.debug(`actuator_${name}_command: ${tagname} ${old_value} => ${new_value}`);
        if (tagname === 'reset_paras' && new_value) {
            actuator.reset_parameter();
            setTimeout(() => {
                command.reset_paras = false;
            }, 500);
            return;
        }
        if (tagname === 'commands') {
            command.has_commands = new_value > 0;
            actuator.debounce_send_commands();
            return;
        }
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
