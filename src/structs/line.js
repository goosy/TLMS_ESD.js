import { build_structure } from "./share.js";

const items = [
    {   // status word
        name: "status", type: "Word", offset: 0, length: 16, init_value: 0,
        is_combined: true, coupling: [ // Note: from high byte
            { name: "bypass", type: "Bool", offset: 8, length: 1, init_value: false }, // Whether bypass
            { name: "pump_run", type: "Bool", offset: 9, length: 1, init_value: false }, // Whether this line pumps
            { name: "alarm_F", type: "Bool", offset: 10, length: 1, init_value: false }, // Whether this line alarms
            { name: "autoStopCmd", type: "Bool", offset: 11, length: 1, init_value: false }, // Auto stop command
            { name: "manStopCmd", type: "Bool", offset: 12, length: 1, init_value: false }, // Manual stop command
            { name: "pre_stop_notice", type: "Bool", offset: 13, length: 1, init_value: false }, // Stop notice
        ],
    },
    { name: "ID", type: "UInt", offset: 16, length: 16, init_value: 0 }, // Line ID
    { name: "action_section_ID", type: "UInt", offset: 32, length: 16, init_value: 0 }, // Section ID of the flow difference action
    { name: "flow_diff", type: "Real", offset: 48, length: 32, init_value: 0 }, // Flow difference bypass (reserved, not implemented)
];

export const LINE = build_structure({ name: "LINE" }, items);
