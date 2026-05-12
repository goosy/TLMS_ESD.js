import { node_commands, node_parameters, build_structure } from "./share.js";
const node_status = [ // Note: from high byte
    { name: "comm_OK", type: "Bool", offset: 8, length: 1, init_value: true }, // Used to maintain node communication status
    { name: "work_OK", type: "Bool", offset: 9, length: 1, init_value: true }, // Used to maintain node work status
    { name: "pump_run", type: "Bool", offset: 10, length: 1, init_value: false }, // Whether the pump is running on this node
    { name: "pump_change_F", type: "Bool", offset: 11, length: 1, init_value: false }, // Whether the pump is in the delay of operation on this node
    { name: "pump_run_1", type: "Bool", offset: 12, length: 1, init_value: false }, // Running status of pump 1
    { name: "pump_run_2", type: "Bool", offset: 13, length: 1, init_value: false }, // Running status of pump 2
    { name: "pump_run_3", type: "Bool", offset: 14, length: 1, init_value: false }, // Running status of pump 3
    { name: "pump_run_4", type: "Bool", offset: 15, length: 1, init_value: false }, // Running status of pump 4
    { name: "pressure_enabled", type: "Bool", offset: 0, length: 1, init_value: false }, // Whether pressure alarm is enabled
    { name: "temperature_enabled", type: "Bool", offset: 1, length: 1, init_value: false }, // Whether temperature alarm is enabled
    { name: "pressure_SD_F", type: "Bool", offset: 2, length: 1, init_value: false }, // Whether pressure linked to stop pump is enabled
    { name: "delay_protect", type: "Bool", offset: 3, length: 1, init_value: true }, // Whether communication interrupt delay protection is enabled
    { name: "pressure_AH_F", type: "Bool", offset: 4, length: 1, init_value: false }, // Whether pressure AH limit alarm is enabled
    { name: "pressure_WH_F", type: "Bool", offset: 5, length: 1, init_value: false }, // Whether pressure WH limit alarm is enabled
    { name: "pressure_WL_F", type: "Bool", offset: 6, length: 1, init_value: false }, // Whether pressure WL limit alarm is enabled
    { name: "pressure_AL_F", type: "Bool", offset: 7, length: 1, init_value: false }, // Whether pressure AL limit alarm is enabled
];

const items = [
    { name: "ID", type: "UInt", offset: 0, length: 16, init_value: 0 },
    {   // Node status
        name: "status", type: "Word", offset: 16, length: 16, init_value: 3,
        is_combined: true, coupling: node_status,
    },
    { name: "temperature", type: "Real", offset: 32, length: 32, init_value: 0 },
    { name: "pressure", type: "Real", offset: 64, length: 32, init_value: 0 },
    { name: "flowmeter", type: "Real", offset: 96, length: 32, init_value: 0 },
    { name: "flowmeter", type: "Real", offset: 96, length: 32, init_value: 0 },
    { // Execution response
        name: "response_code", type: "Word", offset: 128, length: 16, init_value: 0,
        is_combined: true, coupling: node_commands,
    },
    { includes: node_parameters, offset: 144 },
];

export const NODE = build_structure({
    name: "NODE",
    groups: {
        status: { start: 0, end: 144 },
        paras: { start: 144, end: 1168 },
    },
}, items);

