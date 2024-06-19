function reset_parameter(actuator) {
    const { ID, data, command } = actuator;
    const cmd_para_start = (command.groups.paras.start >> 3);
    const data_para_start = (data.groups.paras.start >> 3);
    const data_para_end = (data.groups.paras.end >> 3);
    data.buffer.copy(command.buffer, cmd_para_start, data_para_start, data_para_end);
    command.refresh_value();
    command.ID = ID;
}

async function send_command(actuator) {
    const { data, command } = actuator;
    if (command.has_commands === true || data.response_code !== 0) {
        const start = command.groups.status.start >> 3;
        const end = command.groups.paras.end >> 3;
        const length = end - start;
        await command.IO_write({ start, length });
    }
}

export function node_init(actuator) {
    const { ID, name, data, command, data_driver } = actuator;
    command.name = name + '_CMD';
    data.name = name;

    data.ID = ID;
    data.set_IO(data_driver, {
        start: 0,
        length: data.size,
        poll: true,
    });
    const start = (data.groups.status.start >> 3) + 2;
    const end = data.groups.paras.end >> 3;
    data.on('data', buffer => { // when driver's data buffer coming
        // comm_OK tag offset
        const word_offset = 2;  // Exclude ID tag
        const bit_offset = 0;
        // keep the value of comm_OK tag as 1
        buffer.writeUInt16BE(buffer.readUInt16BE(word_offset) | (1 << bit_offset), word_offset);
        buffer.copy(data.buffer, start, start, end);
        data.refresh_value();
        // @delete temporary code
        // because the PLC is not completed,
        // except stop_pumps enable_pressure_SD disable_pressure_SD and write_paras
        // all commands in response_code are ignored.
        command.command_word = command.command_word & 0xB1;
    });
    data.on("change", (tagname, _o, new_value) => {
        // handle command response_code
        // valid: (handle in PLC)
        //     stop_pumps cancel_stop
        //     enable_pressure_SD disable_pressure_SD
        //     write_paras
        // invalid:
        //     horn reset_horn read_paras
        //     enable_pressure_alarm disable_pressure_alarm
        //     enable_temperature_alarm disable_temperature_alarm
        //     reset_CPU reset_conn
        if (tagname === 'response_code' && new_value) {
            // Reset the corresponding bit in command_word according to response_code
            let command_word = command.command_word;
            command_word = ~new_value & command_word & 0x7fff;
            command.command_word = command_word;
            return;
        }
        if (tagname === 'pressure_SD_F') {
            if (new_value) {
                command.enable_pressure_SD = false;
            } else {
                command.disable_pressure_SD = false;
            }
            return;
        }
        if (tagname === 'pump_run' && !new_value) {
            command.stop_pumps = false;
            return;
        }
    });

    command.ID = ID;
    command.set_IO(data_driver, {
        start: 200 - 16,
        length: command.size,
    });
    data_driver.on("connect", () => {
        // reset parameter
        setTimeout(() => {
            reset_parameter(actuator);
        }, 2000);
    });
    data_driver.on("tick", async () => {
        send_command(actuator);
    });
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
            return;
        }
    });
}

export function node_loop(actuator) {
    const { data, section, data_driver } = actuator;
    const connected = data_driver.isOpen;
    data.comm_OK = connected;
    if (!connected) data.work_OK = false;
}