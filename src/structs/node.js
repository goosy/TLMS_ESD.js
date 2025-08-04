import { node_commands, node_parameters, build_structure } from "./share.js";

const node_status = [
    { name: "comm_OK", type: "Bool", offset: 0, length: 1, init_value: true }, // this node communicate normally
    { name: "work_OK", type: "Bool", offset: 1, length: 1, init_value: true }, // this node are working normally
    { name: "pump_run", type: "Bool", offset: 2, length: 1, init_value: false }, // Is the pump running in this node?
    { name: "pump_change_F", type: "Bool", offset: 3, length: 1, init_value: false }, // Is it within the specified time after operating the pump
    { name: "pump_run_1", type: "Bool", offset: 4, length: 1, init_value: false },
    { name: "pump_run_2", type: "Bool", offset: 5, length: 1, init_value: false },
    { name: "pump_run_3", type: "Bool", offset: 6, length: 1, init_value: false },
    { name: "pump_run_4", type: "Bool", offset: 7, length: 1, init_value: false },
    { name: "pressure_enabled", type: "Bool", offset: 8, length: 1, init_value: false },
    { name: "temperature_enabled", type: "Bool", offset: 9, length: 1, init_value: false },
    { name: "pressure_SD_F", type: "Bool", offset: 10, length: 1, init_value: false }, // Pressure allowable interlock pump stop sign
    { name: "delay_protect", type: "Bool", offset: 11, length: 1, init_value: true }, // Delay protection flag after communication interruption
    { name: "pressure_AH_F", type: "Bool", offset: 12, length: 1, init_value: false },
    { name: "pressure_WH_F", type: "Bool", offset: 13, length: 1, init_value: false },
    { name: "pressure_WL_F", type: "Bool", offset: 14, length: 1, init_value: false },
    { name: "pressure_AL_F", type: "Bool", offset: 15, length: 1, init_value: false },
];

const items = [
    { name: "ID", type: "UInt", offset: 0, length: 16, init_value: 0 },
    { // the status of the node
        name: "status", type: "Word", offset: 16, length: 16, init_value: 3,
        is_combined: true, coupling: node_status,
    },
    { name: "temperature", type: "Real", offset: 32, length: 32, init_value: 0 },
    { name: "pressure", type: "Real", offset: 64, length: 32, init_value: 0 },
    { name: "flowmeter", type: "Real", offset: 96, length: 32, init_value: 0 },
    { // the response code of the node
        name: "response_code", type: "Word", offset: 128, length: 16, init_value: 0,
        is_combined: true, coupling: node_commands,
    },
    { includes: node_parameters, offset: 144 },
];

export const NODE = build_structure({ name: "NODE" }, items);
