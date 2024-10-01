import { node_commands, complete_structure } from "./share.js";

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
    { name: "reserve", type: "Bool", offset: 11, length: 1, init_value: false }, // 预留
    { name: "pressure_AH_F", type: "Bool", offset: 12, length: 1, init_value: false }, // 压力上上限标志
    { name: "pressure_WH_F", type: "Bool", offset: 13, length: 1, init_value: false }, // 压力上限标志
    { name: "pressure_WL_F", type: "Bool", offset: 14, length: 1, init_value: false }, // 压力下限标志
    { name: "pressure_AL_F", type: "Bool", offset: 15, length: 1, init_value: false }, // 压力下下限标志
];

export const NODE = {
    name: "NODE",
    groups: {
        status: { start: 0, end: 144 },
        paras: { start: 144, end: 1168 },
    },
    items: [
        { name: "ID", type: "UInt", offset: 0, length: 16, init_value: 0 },
        {   // 节点状态
            name: "status", type: "Word", offset: 16, length: 16, init_value: 3,
            coupling: node_status,
        },
        { name: "temperature", type: "Real", offset: 32, length: 32, init_value: 0 }, // 温度值
        { name: "pressure", type: "Real", offset: 64, length: 32, init_value: 0 }, // 压力值
        { name: "flowmeter", type: "Real", offset: 96, length: 32, init_value: 0 }, // 流量值
        { //执行应答
            name: "response_code", type: "Word", offset: 128, length: 16, init_value: 0,
            coupling: node_commands,
        },
        { name: "temperature_zero_raw", type: "Int", offset: 144, length: 16, init_value: 0 }, //温度原始零点值
        { name: "temperature_span_raw", type: "Int", offset: 160, length: 16, init_value: 27648 }, //温度原始量程值
        { name: "temperature_underflow", type: "Int", offset: 176, length: 16, init_value: -500 }, //温度下溢出设置值
        { name: "temperature_overflow", type: "Int", offset: 192, length: 16, init_value: 28000 }, //温度上溢出设置值
        { name: "temperature_zero", type: "Real", offset: 208, length: 32, init_value: 0 }, //温度零点值
        { name: "temperature_span", type: "Real", offset: 240, length: 32, init_value: 100 }, //温度量程值
        { name: "temperature_AH", type: "Real", offset: 272, length: 32, init_value: 0 }, //温度高高值
        { name: "temperature_WH", type: "Real", offset: 304, length: 32, init_value: 0 }, //温度高值
        { name: "temperature_WL", type: "Real", offset: 336, length: 32, init_value: 0 }, //温度低值
        { name: "temperature_AL", type: "Real", offset: 368, length: 32, init_value: 0 }, //温度低低值
        { name: "temperature_DZ", type: "Real", offset: 400, length: 32, init_value: 0.5 }, //温度比较死区
        { name: "temperature_FT", type: "UDInt", offset: 432, length: 32, init_value: 0 }, //温度比较容错时间
        { name: "pressure_zero_raw", type: "Int", offset: 464, length: 16, init_value: 0 }, //压力原始零点值
        { name: "pressure_span_raw", type: "Int", offset: 480, length: 16, init_value: 27648 }, //压力原始量程值
        { name: "pressure_underflow", type: "Int", offset: 496, length: 16, init_value: -500 }, //压力下溢出设置值
        { name: "pressure_overflow", type: "Int", offset: 512, length: 16, init_value: 28000 }, //压力上溢出设置值
        { name: "pressure_zero", type: "Real", offset: 528, length: 32, init_value: 0 }, //压力零点值
        { name: "pressure_span", type: "Real", offset: 560, length: 32, init_value: 4 }, //压力量程值
        { name: "pressure_AH", type: "Real", offset: 592, length: 32, init_value: 0 }, //压力高高值
        { name: "pressure_WH", type: "Real", offset: 624, length: 32, init_value: 0 }, //压力高值
        { name: "pressure_WL", type: "Real", offset: 656, length: 32, init_value: 0 }, //压力低值
        { name: "pressure_AL", type: "Real", offset: 688, length: 32, init_value: 0 }, //压力低低值
        { name: "pressure_DZ", type: "Real", offset: 720, length: 32, init_value: 0.05 }, //压力比较死区
        { name: "pressure_FT", type: "UDInt", offset: 752, length: 32, init_value: 0 }, //压力比较容错时间
        { name: "flow1", type: "Real", offset: 784, length: 32, init_value: 0 }, //流量1
        { name: "flow2", type: "Real", offset: 816, length: 32, init_value: 0 }, //流量2
        { name: "flow3", type: "Real", offset: 848, length: 32, init_value: 0 }, //流量3
        { name: "flow4", type: "Real", offset: 880, length: 32, init_value: 0 }, //流量4
        { name: "flow5", type: "Real", offset: 912, length: 32, init_value: 0 }, //流量5
        { name: "flow_smooth_factor", type: "Real", offset: 944, length: 32, init_value: 0.9 }, //流量平滑权值
        { name: "equS1", type: "DInt", offset: 976, length: 32, init_value: 10000 }, //流量1当量
        { name: "equS2", type: "DInt", offset: 1008, length: 32, init_value: 10000 }, //流量2当量
        { name: "equS3", type: "DInt", offset: 1040, length: 32, init_value: 10000 }, //流量3当量
        { name: "equS4", type: "DInt", offset: 1072, length: 32, init_value: 10000 }, //流量4当量
        { name: "equS5", type: "DInt", offset: 1104, length: 32, init_value: 10000 }, //流量5当量
        { name: "pump_change_delay", type: "UDInt", offset: 1136, length: 32, init_value: 180000 }, //泵操作延时
    ]
};

complete_structure(NODE);
