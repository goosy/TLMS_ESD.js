import { complete_structure } from "./TShare.js";

const section_status = [
    { name: "comm_OK", type: "Bool", offset: 0, length: 1, init_value: false }, // 本段所有节点通讯正常
    { name: "work_OK", type: "Bool", offset: 1, length: 1, init_value: false }, // 本段所有节点工作正常
    { name: "protect_F", type: "Bool", offset: 2, length: 1, init_value: false }, // 本段处于保护状态下
    { name: "hangon_AF", type: "Bool", offset: 3, length: 1, init_value: false }, // 本段自动佳起
    { name: "hangon_MF", type: "Bool", offset: 4, length: 1, init_value: false }, // 本段人工挂起
    { name: "action_F", type: "Bool", offset: 5, length: 1, init_value: false }, // 本段是否泄漏停泵
    { name: "flow_warning_F", type: "Bool", offset: 6, length: 1, init_value: false }, // 本段流量警告
    { name: "flow_alarm_F", type: "Bool", offset: 7, length: 1, init_value: false }, // 本段流量报警（预动作）
    { name: "press_warning_F", type: "Bool", offset: 8, length: 1, init_value: false }, // 本段压力警告
    { name: "press_alarm_F", type: "Bool", offset: 9, length: 1, init_value: false }, // 本段压力报警（预动作）
    { name: "autoStopCmd", type: "Bool", offset: 10, length: 1, init_value: false }, // 本段自动停泵
    { name: "manStopCmd", type: "Bool", offset: 11, length: 1, init_value: false }, // 本段人工停泵
    { name: "line_action_source", type: "Bool", offset: 12, length: 1, init_value: false }, // 本段是否为全线停输来源
    { name: "pump_run", type: "Bool", offset: 13, length: 1, init_value: false }, // 本段是否起泵输油
    { name: "pump_change_F", type: "Bool", offset: 14, length: 1, init_value: false }, // 当前时间段是否有泵操作
    { name: "pre_stop_notice", type: "Bool", offset: 15, length: 1, init_value: false }, // 本段准备停泵
];

const inner_tags = [
    { name: "flow_warning_trigger", type: "Bool", offset: 0, length: 1, init_value: false }, // 流量触发警告
    { name: "flow_alarm_trigger", type: "Bool", offset: 1, length: 1, init_value: false }, // 流量触发报警
    { name: "stop_pumps", type: "Bool", offset: 3, length: 1, init_value: false }, // 本段执行停泵
];

export const SECTION = {
    name: "SECTION",
    items: [
        { name: "ID", type: "UInt", offset: 0, length: 16, init_value: 0 }, // 段号
        {   // bypass word
            name: "bypass_word", type: "Word", offset: 16, length: 16, init_value: 0,
            coupling: [{ name: "bypass", type: "Bool", offset: 0, length: 1, init_value: false }], // 中间站点是否有越站
        },
        {   // status word
            name: "status", type: "Word", offset: 32, length: 16, init_value: 0,
            coupling: section_status,
        },
        { name: "flow_begin", type: "Real", offset: 48, length: 32, init_value: 0 }, // 起节点流量合计
        { name: "flow_end", type: "Real", offset: 80, length: 32, init_value: 0 }, // 终节点流量合计
        { name: "flow_diff", type: "Real", offset: 112, length: 32, init_value: 0 }, // 流量差
        { name: "flow_diff_WH", type: "Real", offset: 144, length: 32, init_value: 20 }, // 流量警告差上限值
        { name: "flow_diff_WH_delay", type: "DInt", offset: 176, length: 32, init_value: 3000 }, // 流量警告容错时间（单位毫秒）
        { name: "flow_diff_AH", type: "Real", offset: 208, length: 32, init_value: 50 }, // 流量差报警上限值（动作）
        { name: "flow_diff_AH_delay", type: "DInt", offset: 240, length: 32, init_value: 3000 }, // 流量报警容错时间（单位毫秒）
        { name: "action_time", type: "DInt", offset: 272, length: 32, init_value: 60000 }, // 联锁动作时间（单位毫秒）
        { name: "countdown", type: "Int", offset: 304, length: 16, init_value: 0 }, // 联锁动作倒计时（单位秒）
        {   // inner word
            name: "inner_word", type: "Word", offset: 320, length: 16, init_value: 0,
            coupling: inner_tags,
        },
    ]
};

complete_structure(SECTION);
