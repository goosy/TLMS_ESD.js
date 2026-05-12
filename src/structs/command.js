import { node_commands, node_parameters, build_structure } from "./share.js";
const items = [
    { name: "response_code", type: "Word", offset: 0, length: 16, init_value: 0 }, // No longer used
    { name: "overtime", type: "Int", offset: 16, length: 16, init_value: 5000 }, // Response timeout setting (milliseconds) No longer used
    {   // Extended commands
        name: "extra_commands", type: "Word", offset: 48, length: 16, init_value: 0,
        is_combined: true, coupling: [ // Note: from high byte
            { name: "has_commands", type: "Bool", offset: 8, length: 1, init_value: false }, // Whether there are commands to be sent
            { name: "reset_paras", type: "Bool", offset: 9, length: 1, init_value: false }, // Reset the parameter values to the node parameter values
        ],
    },
    { name: "ID", type: "UInt", offset: 128, length: 16, init_value: 0 }, // Node ID
    {   // Commands
        name: "commands", type: "Word", offset: 144, length: 16, init_value: 0,
        is_combined: true, coupling: node_commands,
    },
    { includes: node_parameters, offset: 160 },
];

export const COMMAND = build_structure({
    name: "COMMAND",
    groups: {
        status: { start: 128, end: 160 },
        paras: { start: 160, end: 1184 },
    },
}, items);
