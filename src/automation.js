
export const
    lines = [],
    sections = [],
    actuators = [];

export function actuator_init(actuator) {
    const { ID, name, data, command, section, data_driver } = actuator;
    command.name = name + '_CMD';
    data.name = name;
    let start = 0;
    data.set("ID", ID);
    data.setIO(data_driver, {
        start,
        length: data.size,
        pollable: true,
        writewritable: false,
    });
    // @todo modify only the specified tags
    data.on('data', buffer => {
        data.replace_buffer(buffer, start);
    });
    start = 200;
    command.set("ID", ID);
    command.setIO(data_driver, {
        start,
        length: command.size,
        pollable: false,
        writewritable: false,
    });
    data.on("change", (tagname, _o, _n) => {
        if (tagname) {
            do_il(section);
        }
    })
}

export function actuator_loop(actuator) {
    const { ID, name, data, command, data_driver } = actuator;
    data.set("work_OK", data_driver.isOpen);
    data.set("comm_OK", data_driver.isOpen);
}

function do_il(section) { }