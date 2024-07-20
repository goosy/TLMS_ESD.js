import { debouncify, logger } from "./util.js";

function get_update_fn(line, line_prop, sections, section_props) {
    section_props ??= [line_prop];
    const getters = sections.map(
        section => section_props.map(
            prop => () => section.data[prop]
        )
    ).flat(1);
    const debounce_key = `line${line.name}_${line_prop}_update`;
    const update_fn = () => {
        line.data[line_prop] = getters.reduce((acc, getter) => {
            return acc || getter();
        }, false);
    }
    return debouncify(debounce_key, update_fn, 50);
}

export function line_init(line) {
    const {
        ID,
        name,
        data,
        sections,
    } = line;
    data.ID = ID;
    data.name = name;
    line.update_pump_run = get_update_fn(
        line, 'pump_run',
        sections
    );
    line.update_alarm_F = get_update_fn(
        line, 'alarm_F',
        sections, ['flow_alarm_F', 'press_alarm_F']
    );
    line.update_pre_stop_notice = get_update_fn(
        line, 'pre_stop_notice',
        sections
    );
    line.update_pump_run();
    line.update_alarm_F();
    line.update_pre_stop_notice();

    data.on("change", (tagname, old_value, new_value) => {
        logger.debug(`line${name}: ${tagname} ${old_value} => ${new_value}`);
        if (tagname === 'bypass') {
            sections.forEach(section => {
                section.data.bypass = new_value;
            });
        }
        if (tagname === 'pump_run' && !new_value) {
            data.autoStopCmd = false;
            data.manStopCmd = false;
        }
    });
}

export function line_loop(line) {
}
