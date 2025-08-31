import { node_commands, node_parameters, build_structure } from "./share.js";
const items = [
    { name: "response_code", type: "Word", offset: 0, length: 16, init_value: 0 }, // No effect
    { name: "overtime", type: "Int", offset: 16, length: 16, init_value: 5000 }, // Response timeout setting (milliseconds) No effect
    {   // Extended commands
        name: "extra_commands", type: "Word", offset: 48, length: 16, init_value: 0,
        is_combined: true, coupling: [
            { name: "has_commands", type: "Bool", offset: 0, length: 1, init_value: false }, // There are commands to be sent
            { name: "reset_paras", type: "Bool", offset: 1, length: 1, init_value: false }, // Reset command parameter values to node parameter values
        ],
    },
    { name: "ID", type: "UInt", offset: 128, length: 16, init_value: 0 }, // Node ID
    {   // Commands
        name: "commands", type: "Word", offset: 144, length: 16, init_value: 0,
        is_combined: true, coupling: node_commands,
    },
    { includes: node_parameters, offset: 160 },
];

export const COMMAND = build_structure({ name: "COMMAND" }, items);
