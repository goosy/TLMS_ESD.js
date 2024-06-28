import { debouncify } from "./util.js";

function reset_parameter(actuator) {
    const { ID, data, command } = actuator;
    const cmd_para_start = command.groups.paras.start >> 3;
    const data_para_start = data.groups.paras.start >> 3;
    const data_para_end = data.groups.paras.end >> 3;
    data.buffer.copy(command.buffer, cmd_para_start, data_para_start, data_para_end);
    command.check_all_tags();
    command.ID = ID;
}

async function send_commands(actuator) {
    const { command } = actuator;
    const start = command.groups.status.start >> 3;
    const end = command.groups.paras.end >> 3;
    const length = end - start;
    await command.IO_write({ start, length });
}

export function node_init(actuator) {
    const { ID, name, data, command, data_driver, command_driver, driver_info } = actuator;
    command.name = name + '_CMD';
    data.name = name;
    const debounce_send_commands = debouncify(`SC4RespCodeOrCmdChan_${name}`, () => {
        send_commands(actuator);
    }, 100);

    data_driver.on("data_error", () => {
        data.work_OK = false;
    });
    data_driver.on("connect", () => {
        // reset parameter
        setTimeout(() => {
            reset_parameter(actuator);
        }, 2000);
    });
    let no_response_count = 0;
    command_driver.on("tick", () => {
        if (command.has_commands === true) no_response_count++;
        else no_response_count = 0;
        if (no_response_count > 2) {
            debounce_send_commands();
        }
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
    data.set_IO(data_driver, {
        remote_start: driver_info.data.start,
        length: data.size,
        poll: true,
    }, ...data_extras);
    const start = (data.groups.status.start >> 3) + 2;
    const end = data.groups.paras.end >> 3;
    data.on('data', buffer => { // when driver's data buffer coming
        // comm_OK tag offset
        const word_offset = 2;  // Exclude ID tag
        const bit_offset = 0;
        // keep the value of comm_OK tag as 1
        buffer.writeUInt16BE(buffer.readUInt16BE(word_offset) | (1 << bit_offset), word_offset);
        buffer.copy(data.buffer, start, start, end);
        data.check_all_tags();
        // @delete temporary code
        // because the PLC is not completed,
        // except stop_pumps enable_pressure_SD disable_pressure_SD and write_paras
        // all commands in response_code are ignored.
        command.command_word = command.command_word & 0xB1;
    });
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
            // Reset the corresponding bit in command_word according to response_code
            let command_word = command.command_word;
            command_word = ~new_value & command_word & 0x7fff;
            command.command_word = command_word;
            if (data.response_code !== 0) debounce_send_commands();
            return;
        }
        if (tagname === 'pressure_SD_F') {
            if (new_value) {
                command.enable_pressure_SD = false;
            } else {
                command.disable_pressure_SD = false;
            }
            debounce_send_commands();
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
        start: 16,
        length: command.size - 16,
    }, ...commands_extras);
    command.on("change", (tagname, _, new_value) => {
        if (tagname === 'reset_paras' && new_value) {
            reset_parameter(actuator);
            setTimeout(() => {
                command.reset_paras = false;
            }, 500);
            return;
        }
        if (tagname === 'command_word') {
            command.has_commands = new_value > 0;
            debounce_send_commands();
            return;
        }
    });

    data_driver.start();
    if(!command_driver.is_connected) command_driver.start();
}

export function node_loop(actuator) {
    const { data, data_driver } = actuator;
    const is_connected = data_driver.is_connected;
    data.comm_OK = is_connected;
    if (!is_connected) data.work_OK = false;
}
