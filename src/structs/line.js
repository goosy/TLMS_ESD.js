import { build_structure } from "./share.js";

const items = [
    {   // status word
        name: "status", type: "Word", offset: 0, length: 16, init_value: 0,
        is_combined: true, coupling: [
            { name: "bypass", type: "Bool", offset: 0, length: 1, init_value: false }, // Whether to bypass
            { name: "pump_run", type: "Bool", offset: 1, length: 1, init_value: false }, // Whether this line pumps oil
            { name: "alarm_F", type: "Bool", offset: 2, length: 1, init_value: false }, // Whether this line has an alarm
            { name: "autoStopCmd", type: "Bool", offset: 3, length: 1, init_value: false }, // Automatic stop command
            { name: "manStopCmd", type: "Bool", offset: 4, length: 1, init_value: false }, // Manual stop command
            { name: "pre_stop_notice", type: "Bool", offset: 5, length: 1, init_value: false }, // Pump stop notice
        ],
    },
    { name: "ID", type: "UInt", offset: 16, length: 16, init_value: 0 }, // This line's ID number
    { name: "action_section_ID", type: "UInt", offset: 32, length: 16, init_value: 0 }, // Section number of the large flow difference action section
    { name: "flow_diff", type: "Real", offset: 48, length: 32, init_value: 0 }, // Flow difference across the station (reserved, not implemented)
];

export const LINE = build_structure({ name: "LINE" }, items);
