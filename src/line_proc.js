export function line_init(line) {
    const {
        ID,
        name,
        data,
    } = line;
    data.on("change", (tagname, _o, new_value) => {
        ;
    });
    data.ID = ID;
    data.name = name;
}

export function line_loop(line) {
    const {
        data,
        controller,
        sections,
    } = line;
    const bypass = line.data.bypass;
    sections.forEach(section => {
        section.data.bypass = bypass;
    });
    const pump_run = sections.reduce((acc, section) => {
        return acc || section.data.pump_run;
    }, false);
    data.pump_run = pump_run;
    const alarm_F = sections.reduce((acc, section) => {
        return acc || section.data.flow_alarm_F || section.data.press_alarm_F;
    }, false);
    data.alarm_F = alarm_F;
    const pre_stop_notice = sections.reduce((acc, section) => {
        return acc || section.data.pre_stop_notice;
    }, false);
    data.pre_stop_notice = pre_stop_notice;
    if (!pump_run) {
        data.autoStopCmd = false;
        data.manStopCmd = false;
    }

}
