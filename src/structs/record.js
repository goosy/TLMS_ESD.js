import { build_structure } from "./share.js";

const items = [
    { name: "year", type: "Uint", offset: 0, length: 16, init_value: 0 }, // Year
    { name: "month", type: "Uint", offset: 16, length: 16, init_value: 0 }, // Month
    { name: "day", type: "Uint", offset: 32, length: 16, init_value: 0 }, // Day
    { name: "hour", type: "Uint", offset: 48, length: 16, init_value: 0 }, // Hour
    { name: "minute", type: "Uint", offset: 64, length: 16, init_value: 0 }, // Minute
    { name: "second", type: "Uint", offset: 80, length: 16, init_value: 0 }, // Second
    { name: "section_ID", type: "UInt", offset: 96, length: 16, init_value: 0 }, // Section ID for action, 0 for no record
    { name: "flow_begin", type: "Real", offset: 112, length: 32, init_value: 0 }, // Flow sum of the start node of the action section
    { name: "flow_end", type: "Real", offset: 144, length: 32, init_value: 0 }, // Flow sum of the end node of the action section
    { name: "flow_diff", type: "Real", offset: 176, length: 32, init_value: 0 }, // Flow difference of the action section
    { name: "node1_press", type: "Real", offset: 208, length: 32, init_value: 0 }, // Pressure of node 1 of the action section
    { name: "node2_press", type: "Real", offset: 240, length: 32, init_value: 0 }, // Pressure of node 2 of the action section
    { name: "node3_press", type: "Real", offset: 272, length: 32, init_value: 0 }, // Pressure of node 3 of the action section
    { name: "node4_press", type: "Real", offset: 304, length: 32, init_value: 0 }, // Pressure of node 4 of the action section
    { name: "node1_ID", type: "UInt", offset: 336, length: 16, init_value: 0 }, // Node 1 ID of the action section
    { name: "node2_ID", type: "UInt", offset: 352, length: 16, init_value: 0 }, // Node 2 ID of the action section
    { name: "node3_ID", type: "UInt", offset: 368, length: 16, init_value: 0 }, // Node 3 ID of the action section
    { name: "node4_ID", type: "UInt", offset: 384, length: 16, init_value: 0 }, // Node 4 ID of the action section
    {   // status
        name: "status", type: "Word", offset: 400, length: 16, init_value: 0,
        is_combined: true, coupling: [ // Note: from high byte
            { name: "press_action", type: "Bool", offset: 8, length: 1, init_value: false }, // Pressure exceeds the limit and takes action
            { name: "flow_action", type: "Bool", offset: 9, length: 1, init_value: false }, // Flow difference exceeds the limit and takes action
            { name: "node1_pump_run", type: "Bool", offset: 10, length: 1, init_value: false }, // Node 1 of the action section has an open pump
            { name: "node2_pump_run", type: "Bool", offset: 11, length: 1, init_value: false }, // Node 2 of the action section has an open pump
            { name: "node3_pump_run", type: "Bool", offset: 12, length: 1, init_value: false }, // Node 3 of the action section has an open pump
            { name: "node4_pump_run", type: "Bool", offset: 13, length: 1, init_value: false }, // Node 4 of the action section has an open pump
        ],
    },
    { name: "index", type: "Int", offset: 416, length: 16, init_value: -1 }, // The reverse order of the record, 0 for the latest
];

export const RECORD = build_structure({ name: "RECORD" }, items);
