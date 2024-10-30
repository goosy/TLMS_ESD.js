import { build_structure } from "./share.js";

const items = [
    { name: "year", type: "Uint", offset: 0, length: 16, init_value: 0 },
    { name: "month", type: "Uint", offset: 16, length: 16, init_value: 0 },
    { name: "day", type: "Uint", offset: 32, length: 16, init_value: 0 },
    { name: "hour", type: "Uint", offset: 48, length: 16, init_value: 0 },
    { name: "minute", type: "Uint", offset: 64, length: 16, init_value: 0 },
    { name: "second", type: "Uint", offset: 80, length: 16, init_value: 0 },
    { name: "section_ID", type: "UInt", offset: 96, length: 16, init_value: 0 }, // 0 means there is no record yet
    { name: "flow_begin", type: "Real", offset: 112, length: 32, init_value: 0 },
    { name: "flow_end", type: "Real", offset: 144, length: 32, init_value: 0 },
    { name: "flow_diff", type: "Real", offset: 176, length: 32, init_value: 0 },
    { name: "node1_press", type: "Real", offset: 208, length: 32, init_value: 0 },
    { name: "node2_press", type: "Real", offset: 240, length: 32, init_value: 0 },
    { name: "node3_press", type: "Real", offset: 272, length: 32, init_value: 0 },
    { name: "node4_press", type: "Real", offset: 304, length: 32, init_value: 0 },
    { name: "node1_ID", type: "UInt", offset: 336, length: 16, init_value: 0 },
    { name: "node2_ID", type: "UInt", offset: 352, length: 16, init_value: 0 },
    { name: "node3_ID", type: "UInt", offset: 368, length: 16, init_value: 0 },
    { name: "node4_ID", type: "UInt", offset: 384, length: 16, init_value: 0 },
    {
        name: "status", type: "Word", offset: 400, length: 16, init_value: 0,
        is_combined: true, coupling: [
            { name: "press_action", type: "Bool", offset: 0, length: 1, init_value: false },
            { name: "flow_action", type: "Bool", offset: 1, length: 1, init_value: false },
            { name: "node1_pump_run", type: "Bool", offset: 2, length: 1, init_value: false },
            { name: "node2_pump_run", type: "Bool", offset: 3, length: 1, init_value: false },
            { name: "node3_pump_run", type: "Bool", offset: 4, length: 1, init_value: false },
            { name: "node4_pump_run", type: "Bool", offset: 5, length: 1, init_value: false },
        ],
    },
    { name: "index", type: "Int", offset: 416, length: 16, init_value: -1 }, // the index value of the last record, 0 is the latest
];

export const RECORD = build_structure({ name: "RECORD" }, items);
