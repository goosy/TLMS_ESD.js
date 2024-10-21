import { node_commands, node_parameters, build_structure } from "./share.js";

const node_status = [
    { name: "comm_OK", type: "Bool", offset: 0, length: 1, init_value: true }, // 用于维护节点通讯状态
    { name: "work_OK", type: "Bool", offset: 1, length: 1, init_value: true }, // 用于维护节点工作状态
    { name: "pump_run", type: "Bool", offset: 2, length: 1, init_value: false }, // 本节点有泵运行
    { name: "pump_change_F", type: "Bool", offset: 3, length: 1, init_value: false }, // 本节点是否处于泵操作延时
    { name: "pump_run_1", type: "Bool", offset: 4, length: 1, init_value: false }, // 1#泵运行状态
    { name: "pump_run_2", type: "Bool", offset: 5, length: 1, init_value: false }, // 2#泵运行状态
    { name: "pump_run_3", type: "Bool", offset: 6, length: 1, init_value: false }, // 3#泵运行状态
    { name: "pump_run_4", type: "Bool", offset: 7, length: 1, init_value: false }, // 4#泵运行状态
    { name: "pressure_enabled", type: "Bool", offset: 8, length: 1, init_value: false }, // 压力允许报警标志
    { name: "temperature_enabled", type: "Bool", offset: 9, length: 1, init_value: false }, // 温度允许报警标志
    { name: "pressure_SD_F", type: "Bool", offset: 10, length: 1, init_value: false }, // 压力允许联锁停输标志
    { name: "delay_protect", type: "Bool", offset: 11, length: 1, init_value: true }, // 通讯中断延迟保护
    { name: "pressure_AH_F", type: "Bool", offset: 12, length: 1, init_value: false }, // 压力上上限标志
    { name: "pressure_WH_F", type: "Bool", offset: 13, length: 1, init_value: false }, // 压力上限标志
    { name: "pressure_WL_F", type: "Bool", offset: 14, length: 1, init_value: false }, // 压力下限标志
    { name: "pressure_AL_F", type: "Bool", offset: 15, length: 1, init_value: false }, // 压力下下限标志
];

const items = [
    { name: "ID", type: "UInt", offset: 0, length: 16, init_value: 0 },
    {   // 节点状态
        name: "status", type: "Word", offset: 16, length: 16, init_value: 3,
        is_combined: true, coupling: node_status,
    },
    { name: "temperature", type: "Real", offset: 32, length: 32, init_value: 0 }, // 温度值
    { name: "pressure", type: "Real", offset: 64, length: 32, init_value: 0 }, // 压力值
    { name: "flowmeter", type: "Real", offset: 96, length: 32, init_value: 0 }, // 流量值
    { //执行应答
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
