import { debouncify } from "./util.js";

export function node_init(actuator) {
    const { ID, name, data, command, data_driver, command_driver, driver_info } = actuator;
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
    data_driver.on("data_error", () => {
        data.work_OK = false;
    });
    data_driver.on("connect", () => {
        // reset parameter
        setTimeout(actuator.reset_parameter, 2000);
    });
    const data_extras = [];
    const commands_extras = [];
    if (driver_info.protocol === 'S7') {
        const data = driver_info.data;
        data_extras.push(data.area, data.db);
        const commands = driver_info.commands;
        commands_extras.push(commands.area, commands.db);
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
        'flow1', 'flow2', 'flow3', 'flow4', 'flow5',
        'flow_smooth_factor',
        'equS1', 'equS2', 'equS3', 'equS4', 'equS5',
        'pump_change_delay',
    );
    actuator.data_payload = data_payload;

    data.on("change", (tagname, old_value, new_value) => {
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
        if (tagname === 'response_code' && new_value) {
            // Reset the corresponding bit in commands according to response_code
            command.commands = ~new_value & command.commands;
            command.executing = false;
            if (data.response_code !== 0) actuator.debounce_send_commands();
            return;
        }
        if (tagname === 'pressure_SD_F') {
            if (new_value) {
                command.enable_pressure_SD = false;
            } else {
                command.disable_pressure_SD = false;
            }
            actuator.debounce_send_commands();
            return;
        }
        if (tagname === 'pump_run' && !new_value) {
            command.stop_pumps = false;
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
        'flow1', 'flow2', 'flow3', 'flow4', 'flow5',
        'flow_smooth_factor',
        'equS1', 'equS2', 'equS3', 'equS4', 'equS5',
        'pump_change_delay',
    );
    actuator.commands_payload = commands_payload;

    command.on("change", (tagname, _, new_value) => {
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
    const is_connected = data_driver.is_connected;
    data.comm_OK = is_connected;
    if (is_connected) {
        // read a node data.
        actuator.data_payload.read();
        // @TODO check the correctness of the ID
        data.comm_OK = true;
        // @delete temporary code
        // because the PLC is not completed,
        // all commands except stop_pumps enable_pressure_SD disable_pressure_SD and write_paras
        // will reset unconditionally.
        command.commands = command.commands & 0xB1;
    } else {
        data.work_OK = false;
    }
    if (command.has_commands === true) no_response_count++;
    else no_response_count = 0;
    if (no_response_count > 2) {
        actuator.debounce_send_commands();
    }
}
