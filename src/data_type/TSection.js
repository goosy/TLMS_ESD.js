export const SECTION = {
    name: "SECTION",
    length: 352,
    items: [
        { name: "abnormal", type: "Bool", offset: 0, length: 1, init_value: false }, // 是否工作在异常模式下(越站)
        { name: "hangon_MF", type: "Bool", offset: 1, length: 1, init_value: false }, // 本段人工挂起
        { name: "warning_flow_diff", type: "Real", offset: 16, length: 32, init_value: 20 }, // 流量警告差上限值
        { name: "warning_flow_delay", type: "DInt", offset: 48, length: 32, init_value: 10000 }, // 流量警告容错时间（单位毫秒）
        { name: "alarm_flow_diff", type: "Real", offset: 80, length: 32, init_value: 50 }, // 流量差报警上限值（动作）
        { name: "alarm_flow_delay", type: "DInt", offset: 112, length: 32, init_value: 10000 }, // 流量报警容错时间（单位毫秒）
        { name: "action_time", type: "DInt", offset: 144, length: 32, init_value: 60000 }, // 联锁动作时间（单位毫秒）
        { name: "ID", type: "UInt", offset: 176, length: 16, init_value: 0 }, // 段号
        { name: "comm_OK", type: "Bool", offset: 192, length: 1, init_value: false }, // 本段所有节点通讯正常
        { name: "work_OK", type: "Bool", offset: 193, length: 1, init_value: false }, // 本段所有节点工作正常
        { name: "pre_stop_notice", type: "Bool", offset: 194, length: 1, init_value: false }, // 本段准备停泵
        { name: "protect_F", type: "Bool", offset: 195, length: 1, init_value: false }, // 本段处于保护状态下
        { name: "hangon_AF", type: "Bool", offset: 196, length: 1, init_value: false }, // 本段自动佳起
        { name: "action_F", type: "Bool", offset: 197, length: 1, init_value: false }, // 本段是否泄漏停泵
        { name: "flow_warning_F", type: "Bool", offset: 198, length: 1, init_value: false }, // 本段流量警告
        { name: "flow_alarm_F", type: "Bool", offset: 199, length: 1, init_value: false }, // 本段流量报警（预动作）
        { name: "press_warning_F", type: "Bool", offset: 200, length: 1, init_value: false }, // 本段压力警告
        { name: "press_alarm_F", type: "Bool", offset: 201, length: 1, init_value: false }, // 本段压力报警（预动作）
        { name: "action_source", type: "Bool", offset: 202, length: 1, init_value: false }, // 本段引发全线停输命令
        { name: "pump_run", type: "Bool", offset: 203, length: 1, init_value: false }, // 本段是否起泵输油
        { name: "pump_change_F", type: "Bool", offset: 204, length: 1, init_value: false }, // 当前时间段是否有泵操作
        { name: "stop_pumps", type: "Bool", offset: 205, length: 1, init_value: false }, // 本段停泵
        { name: "cancel_stop", type: "Bool", offset: 206, length: 1, init_value: false }, // 取消本段停泵
        { name: "flow_begin", type: "Real", offset: 208, length: 32, init_value: 0 }, // 起节点流量合计
        { name: "flow_end", type: "Real", offset: 240, length: 32, init_value: 0 }, // 终节点流量合计
        { name: "flow_diff", type: "Real", offset: 272, length: 32, init_value: 0 }, // 流量差
        { name: "action_ET", type: "Dint", offset: 304, length: 32, init_value: 0 }, // 动作倒计时
        { name: "autoStopCmd", type: "Bool", offset: 336, length: 1, init_value: false }, // 本段自动停泵
        { name: "manStopCmd", type: "Bool", offset: 337, length: 1, init_value: false }, // 本段人工停泵
    ]
};
