import { complete_structure } from "./share.js";

export const RECORD = {
    name: "RECORD",
    items: [
        { name: "year", type: "Uint", offset: 0, length: 16, init_value: 0 }, // 年
        { name: "month", type: "Uint", offset: 16, length: 16, init_value: 0 }, // 月
        { name: "day", type: "Uint", offset: 32, length: 16, init_value: 0 }, // 日
        { name: "hour", type: "Uint", offset: 48, length: 16, init_value: 0 }, // 时
        { name: "minute", type: "Uint", offset: 64, length: 16, init_value: 0 }, // 分
        { name: "second", type: "Uint", offset: 80, length: 16, init_value: 0 }, // 秒
        { name: "section_ID", type: "UInt", offset: 96, length: 16, init_value: 0 }, // 引发动作的段ID 为0表示还没有记录
        { name: "flow_begin", type: "Real", offset: 112, length: 32, init_value: 0 }, // 动作段始节点流量和
        { name: "flow_end", type: "Real", offset: 144, length: 32, init_value: 0 }, // 动作段终节点流量和
        { name: "flow_diff", type: "Real", offset: 176, length: 32, init_value: 0 }, // 动作段流差
        { name: "node1_press", type: "Real", offset: 208, length: 32, init_value: 0 }, // 动作段节点1压力
        { name: "node2_press", type: "Real", offset: 240, length: 32, init_value: 0 }, // 动作段节点2压力
        { name: "node3_press", type: "Real", offset: 272, length: 32, init_value: 0 }, // 动作段节点3压力
        { name: "node4_press", type: "Real", offset: 304, length: 32, init_value: 0 }, // 动作段节点4压力
        { name: "node1_ID", type: "UInt", offset: 336, length: 16, init_value: 0 }, // 动作段节点1ID
        { name: "node2_ID", type: "UInt", offset: 352, length: 16, init_value: 0 }, // 动作段节点2ID
        { name: "node3_ID", type: "UInt", offset: 368, length: 16, init_value: 0 }, // 动作段节点3ID
        { name: "node4_ID", type: "UInt", offset: 384, length: 16, init_value: 0 }, // 动作段节点4ID
        {   // 状态
            name: "status", type: "Word", offset: 400, length: 16, init_value: 0,
            coupling: [
                { name: "press_action", type: "Bool", offset: 0, length: 1, init_value: false }, // 压力超限动作
                { name: "flow_action", type: "Bool", offset: 1, length: 1, init_value: false }, // 输差超限动作
                { name: "node1_pump_run", type: "Bool", offset: 2, length: 1, init_value: false }, // 动作段始节点1有开泵
                { name: "node2_pump_run", type: "Bool", offset: 3, length: 1, init_value: false }, // 动作段始节点2有开泵
                { name: "node3_pump_run", type: "Bool", offset: 4, length: 1, init_value: false }, // 动作段始节点3有开泵
                { name: "node4_pump_run", type: "Bool", offset: 5, length: 1, init_value: false }, // 动作段始节点4有开泵
            ],
        },
        { name: "index", type: "Int", offset: 416, length: 16, init_value: -1 }, // 倒数第几个记录，0为最新
    ]
}
complete_structure(RECORD);
