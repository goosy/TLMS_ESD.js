import { build_structure } from "./share.js";

const section_status = [ // Note: from high byte
    { name: "comm_OK", type: "Bool", offset: 8, length: 1, init_value: false }, // Whether all nodes in this section communicate normally
    { name: "work_OK", type: "Bool", offset: 9, length: 1, init_value: false }, // Whether all nodes in this section work normally
    { name: "protect_F", type: "Bool", offset: 10, length: 1, init_value: false }, // Whether this section is in protective mode
    { name: "hangon_AF", type: "Bool", offset: 11, length: 1, init_value: false }, // Whether this section is automatically hung up
    { name: "hangon_MF", type: "Bool", offset: 12, length: 1, init_value: false }, // Whether this section is manually hung up
    { name: "action_F", type: "Bool", offset: 13, length: 1, init_value: false }, // Whether this section is in the action of stopping the pump due to leakage
    { name: "flow_warning_F", type: "Bool", offset: 14, length: 1, init_value: false }, // Whether this section is in the flow warning status
    { name: "flow_alarm_F", type: "Bool", offset: 15, length: 1, init_value: false }, // Whether this section is in the flow alarm status
    { name: "press_warning_F", type: "Bool", offset: 0, length: 1, init_value: false }, // Whether this section is in the pressure warning status
    { name: "press_alarm_F", type: "Bool", offset: 1, length: 1, init_value: false }, // Whether this section is in the pressure alarm status
    { name: "autoStopCmd", type: "Bool", offset: 2, length: 1, init_value: false }, // Whether this section is in the auto stop status
    { name: "manStopCmd", type: "Bool", offset: 3, length: 1, init_value: false }, // Whether this section is in the manual stop status
    { name: "line_action_source", type: "Bool", offset: 4, length: 1, init_value: false }, // Whether this section is the source of the line action
    { name: "pump_run", type: "Bool", offset: 5, length: 1, init_value: false }, // Whether this section has an open pump
    { name: "pump_change_F", type: "Bool", offset: 6, length: 1, init_value: false }, // Whether there is a pump operation in the current time period
    { name: "pre_stop_notice", type: "Bool", offset: 7, length: 1, init_value: false }, // Whether this section is in the pre-stop status
];

const inner_tags = [ // Note: from high byte
    { name: "flow_warning_trigger", type: "Bool", offset: 8, length: 1, init_value: false }, // Whether flow warning has been triggered
    { name: "flow_alarm_trigger", type: "Bool", offset: 9, length: 1, init_value: false }, // Whether flow alarm has been triggered
    { name: "stop_pumps", type: "Bool", offset: 11, length: 1, init_value: false }, // Whether this section has executed stop pump
];

const items = [
    { name: "ID", type: "UInt", offset: 0, length: 16, init_value: 0 }, // Section ID
    {   // bypass word
        name: "bypass_word", type: "Word", offset: 16, length: 16, init_value: 0,
        is_combined: true, coupling: [ // Note: from high byte
            { name: "bypass", type: "Bool", offset: 8, length: 1, init_value: false } // Whether there is bypass in the intermediate station
        ],
    },
    {   // status word
        name: "status", type: "Word", offset: 32, length: 16, init_value: 0,
        is_combined: true, coupling: section_status,
    },
    { name: "flow_begin", type: "Real", offset: 48, length: 32, init_value: 0 }, // Total flow of the starting node
    { name: "flow_end", type: "Real", offset: 80, length: 32, init_value: 0 }, // Total flow of the ending node
    { name: "flow_diff", type: "Real", offset: 112, length: 32, init_value: 0 }, // Flow difference
    { name: "flow_diff_WH", type: "Real", offset: 144, length: 32, init_value: 20 }, // Flow warning difference upper limit
    { name: "flow_diff_WH_delay", type: "DInt", offset: 176, length: 32, init_value: 3000 }, // Flow warning tolerance time (in milliseconds)
    { name: "flow_diff_AH", type: "Real", offset: 208, length: 32, init_value: 50 }, // Flow difference alarm upper limit
    { name: "flow_diff_AH_delay", type: "DInt", offset: 240, length: 32, init_value: 3000 }, // Flow alarm tolerance time (in milliseconds)
    { name: "action_time", type: "DInt", offset: 272, length: 32, init_value: 60000 }, // Linked action time (in milliseconds)
    { name: "countdown", type: "Int", offset: 304, length: 16, init_value: 0 }, // Linked action countdown (in seconds)
    {   // inner word
        name: "inner_word", type: "Word", offset: 320, length: 16, init_value: 0,
        coupling: inner_tags,
    },
];

export const SECTION = build_structure({ name: "SECTION" }, items);

