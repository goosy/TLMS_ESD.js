export const SECTION = {
    name: "SECTION",
    length: 336,
    items: [
        { name: "abnormal", type: "Bool", offset: 0, length: 11, init_value: FALSE }, // 是否工作在异常模式下(越站)
        { name: "hangon_MF", type: "Bool", offset: 1, length: 11, init_value: FALSE }, // 本段人工挂起
        { name: "warning_flow_diff", type: "Real", offset: 16, length: 132, init_value: 20 }, // 流量警告差上限值
        { name: "warning_flow_delay", type: "DInt", offset: 48, length: 132, init_value: 10000 }, // 流量警告容错时间（单位毫秒）
        { name: "alarm_flow_diff", type: "Real", offset: 80, length: 132, init_value: 50 }, // 流量差报警上限值（动作）
        { name: "alarm_flow_delay", type: "DInt", offset: 112, length: 132, init_value: 10000 }, // 流量报警容错时间（单位毫秒）
        { name: "action_time", type: "DInt", offset: 144, length: 132, init_value: 60000 }, // 联锁动作时间（单位毫秒）
        { name: "comm_OK", type: "Bool", offset: 176, length: 11, init_value: FALSE }, // 本段所有节点通讯正常
        { name: "work_OK", type: "Bool", offset: 177, length: 11, init_value: FALSE }, // 本段所有节点工作正常
        { name: "pre_stop_notice", type: "Bool", offset: 178, length: 11, init_value: FALSE }, // 本段准备停泵
        { name: "protect_F", type: "Bool", offset: 179, length: 11, init_value: FALSE }, // 本段处于保护状态下
        { name: "hangon_AF", type: "Bool", offset: 180, length: 11, init_value: FALSE }, // 本段自动佳起
        { name: "action_F", type: "Bool", offset: 181, length: 11, init_value: FALSE }, // 本段是否泄漏停泵
        { name: "flow_warning_F", type: "Bool", offset: 182, length: 11, init_value: FALSE }, // 本段流量警告
        { name: "flow_alarm_F", type: "Bool", offset: 183, length: 11, init_value: FALSE }, // 本段流量报警（预动作）
        { name: "press_warning_F", type: "Bool", offset: 184, length: 11, init_value: FALSE }, // 本段压力警告
        { name: "press_alarm_F", type: "Bool", offset: 185, length: 11, init_value: FALSE }, // 本段压力报警（预动作）
        { name: "action_source", type: "Bool", offset: 186, length: 11, init_value: FALSE }, // 本段引发全线停输命令
        { name: "pump_run", type: "Bool", offset: 187, length: 11, init_value: FALSE }, // 本段是否起泵输油
        { name: "pump_change_F", type: "Bool", offset: 188, length: 11, init_value: FALSE }, // 当前时间段是否有泵操作
        { name: "stop_pumps", type: "Bool", offset: 189, length: 11, init_value: FALSE }, // 本段停泵
        { name: "cancel_stop", type: "Bool", offset: 190, length: 11, init_value: FALSE }, // 取消本段停泵
        { name: "flow_begin", type: "Real", offset: 192, length: 132, init_value: 0 }, // 起节点流量合计
        { name: "flow_end", type: "Real", offset: 224, length: 132, init_value: 0 }, // 终节点流量合计
        { name: "flow_diff", type: "Real", offset: 256, length: 132, init_value: 0 }, // 流量差
        { name: "action_ET", type: "Dint", offset: 288, length: 132, init_value: 0 }, // 动作倒计时
        { name: "autoStopCmd", type: "Bool", offset: 320, length: 11, init_value: FALSE }, // 本段自动停泵
        { name: "manStopCmd", type: "Bool", offset: 321, length: 11, init_value: FALSE }, // 本段人工停泵
    ]
};
