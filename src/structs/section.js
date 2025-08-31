import { build_structure } from "./share.js";

const section_status = [
    { name: "comm_OK", type: "Bool", offset: 0, length: 1, init_value: false }, // All nodes in this section communicate normally
    { name: "work_OK", type: "Bool", offset: 1, length: 1, init_value: false }, // All nodes in this section are working normally
    { name: "protect_F", type: "Bool", offset: 2, length: 1, init_value: false }, // This section is under protection
    { name: "hangon_AF", type: "Bool", offset: 3, length: 1, init_value: false }, // This section is suspended automatically
    { name: "hangon_MF", type: "Bool", offset: 4, length: 1, init_value: false }, // This section is suspended manually
    { name: "action_F", type: "Bool", offset: 5, length: 1, init_value: false }, // Stop the pump if there is leakage in this section
    { name: "flow_warning_F", type: "Bool", offset: 6, length: 1, init_value: false },
    { name: "flow_alarm_F", type: "Bool", offset: 7, length: 1, init_value: false },
    { name: "press_warning_F", type: "Bool", offset: 8, length: 1, init_value: false },
    { name: "press_alarm_F", type: "Bool", offset: 9, length: 1, init_value: false },
    { name: "autoStopCmd", type: "Bool", offset: 10, length: 1, init_value: false }, // the command to stop pumps automatically
    { name: "manStopCmd", type: "Bool", offset: 11, length: 1, init_value: false }, // the command to stop pumps manually
    { name: "line_action_source", type: "Bool", offset: 12, length: 1, init_value: false }, // Is this section the source of the line action
    { name: "pump_run", type: "Bool", offset: 13, length: 1, init_value: false }, // Is the pump running in this section?
    { name: "pump_change_F", type: "Bool", offset: 14, length: 1, init_value: false }, // Is it within the specified time after operating the pump?
    { name: "pre_stop_notice", type: "Bool", offset: 15, length: 1, init_value: false }, // This section is about to stop the pump.
];

const inner_tags = [
    { name: "flow_warning_trigger", type: "Bool", offset: 0, length: 1, init_value: false },
    { name: "flow_alarm_trigger", type: "Bool", offset: 1, length: 1, init_value: false },
    { name: "stop_pumps", type: "Bool", offset: 3, length: 1, init_value: false },
];

const items = [
    { name: "ID", type: "UInt", offset: 0, length: 16, init_value: 0 },
    {   // bypass word
        name: "bypass_word", type: "Word", offset: 16, length: 16, init_value: 0,
        is_combined: true, coupling: [
            { name: "bypass", type: "Bool", offset: 0, length: 1, init_value: false }
        ],
    },
    {   // status word
        name: "status", type: "Word", offset: 32, length: 16, init_value: 0,
        is_combined: true, coupling: section_status,
    },
    { name: "flow_begin", type: "Real", offset: 48, length: 32, init_value: 0 },
    { name: "flow_end", type: "Real", offset: 80, length: 32, init_value: 0 },
    { name: "flow_diff", type: "Real", offset: 112, length: 32, init_value: 0 },
    { name: "flow_diff_WH", type: "Real", offset: 144, length: 32, init_value: 20 },
    { name: "flow_diff_WH_delay", type: "DInt", offset: 176, length: 32, init_value: 3000 }, // unit ms
    { name: "flow_diff_AH", type: "Real", offset: 208, length: 32, init_value: 50 },
    { name: "flow_diff_AH_delay", type: "DInt", offset: 240, length: 32, init_value: 3000 }, // unit ms
    { name: "action_time", type: "DInt", offset: 272, length: 32, init_value: 60000 }, // unit ms
    { name: "countdown", type: "Int", offset: 304, length: 16, init_value: 0 }, // unit second
    {   // inner word
        name: "inner_word", type: "Word", offset: 320, length: 16, init_value: 0,
        coupling: inner_tags,
    },
];

export const SECTION = build_structure({ name: "SECTION" }, items);
