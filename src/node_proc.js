export const
    lines = [],
    sections = [],
    actuators = [];

function reset_parameter(actuator) {
    const { ID, data, command } = actuator;
    const data_para_start = (data.groups.paras.start >> 3);
    const cmd_para_start = (command.groups.paras.start >> 3);
    const cmd_para_end = (command.groups.paras.end >> 3);
    data.buffer.copy(command.buffer, data_para_start, cmd_para_start, cmd_para_end);
    command.set("ID", ID);
    command.refresh_value();
}

async function send_command(actuator) {
    const { data, command, data_driver } = actuator;
    if (command.get('has_commands') === true || data.get('response_code') !== 0) {
        let start = command.groups.status.start >> 3;
        const end = command.groups.paras.end >> 3;
        const buffer = command.buffer.subarray(start, end);
        const length = start - start;
        start = command.buffer_info.start;
        await data_driver.write(buffer, { start, length });
    }
}

export function actuator_init(actuator) {
    const { ID, name, data, command, section, data_driver } = actuator;
    command.name = name + '_CMD';
    data.name = name;

    data.set("ID", ID);
    data.setIO(data_driver, {
        start: 0,
        length: data.size,
        pollable: true,
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
            let command_word = command.get('command_word');
            command_word = ~new_value & command_word & 0x7fff;
            command.set('command_word', command_word);
            return;
        }
    });

    command.set("ID", ID);
    command.setIO(data_driver, {
        start: 200,
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
                command.set('reset_paras', false);
            }, 500);
            return;
        }
        if (tagname === 'command_word') {
            command.set('has_commands', new_value > 0);
            return;
        }
    });
}

export function actuator_loop(actuator) {
    const { ID, name, data, command, section, data_driver } = actuator;
    const connected = data_driver.isOpen;
    data.set("comm_OK", connected);
    if (!connected) data.set("work_OK", false);
    do_section(section);
}

function do_section(section) { }