export const COMMAND = {
    name: "COMMAND",
    length: 1184,
    groups: {
        status: { start: 128, end: 160 },
        paras: { start: 160, end: 1184 },
    },
    items: [
        { name: "response_code", type: "UInt", offset: 0, length: 16, init_value: 0 }, // 节点执行后的应答代码
        { name: "overtime", type: "Int", offset: 16, length: 16, init_value: 5000 }, // 应答超时设定(毫秒)
        { name: "has_commands", type: "Bool", offset: 48, length: 1, init_value: false }, // 当前有命令需要发送
        { name: "reset_paras", type: "Bool", offset: 64, length: 1, init_value: false }, // 将命令参数值重置为节点参数值
        { name: "ID", type: "UInt", offset: 128, length: 16, init_value: 8012 }, // 节点ID
        { name: "command_word", type: "Word", offset: 144, length: 16, init_value: 0 }, // 命令字
        { name: "stop_pumps", type: "Bool", offset: 144, length: 1, init_value: false }, // 停泵命令
        { name: "cancel_stop", type: "Bool", offset: 145, length: 1, init_value: false }, // 取消停泵
        { name: "horn", type: "Bool", offset: 146, length: 1, init_value: false }, // 输出报警
        { name: "reset_horn", type: "Bool", offset: 147, length: 1, init_value: false }, // 停止报警
        { name: "enable_pressure_SD", type: "Bool", offset: 148, length: 1, init_value: false }, // 设置压力联锁停泵
        { name: "disable_pressure_SD", type: "Bool", offset: 149, length: 1, init_value: false }, // 取消压力联锁停泵
        { name: "read_paras", type: "Bool", offset: 150, length: 1, init_value: false }, // 读取所有参数
        { name: "write_paras", type: "Bool", offset: 151, length: 1, init_value: false }, // 写参数命令
        { name: "enable_pressure_alarm", type: "Bool", offset: 152, length: 1, init_value: false }, // 允许压力报警
        { name: "disable_pressure_alarm", type: "Bool", offset: 153, length: 1, init_value: false }, // 禁止压力报警
        { name: "enable_temperature_alarm", type: "Bool", offset: 154, length: 1, init_value: false }, // 允许温度报警
        { name: "disable_temperature_alarm", type: "Bool", offset: 155, length: 1, init_value: false }, // 禁止温度报警
        { name: "reset_CPU", type: "Bool", offset: 156, length: 1, init_value: false }, // 预留
        { name: "reset_conn", type: "Bool", offset: 157, length: 1, init_value: false }, // 预留
        { name: "temperature_zero_raw", type: "Int", offset: 160, length: 16, init_value: 0 }, // 温度原始零点值
        { name: "temperature_span_raw", type: "Int", offset: 176, length: 16, init_value: 27648 }, // 温度原始量程值
        { name: "temperature_underflow", type: "Int", offset: 192, length: 16, init_value: -500 }, // 温度下溢出设置值
        { name: "temperature_overflow", type: "Int", offset: 208, length: 16, init_value: 28000 }, // 温度上溢出设置值
        { name: "temperature_zero", type: "Real", offset: 224, length: 32, init_value: 0 }, // 温度零点值
        { name: "temperature_span", type: "Real", offset: 256, length: 32, init_value: 100 }, // 温度量程值
        { name: "temperature_AH", type: "Real", offset: 288, length: 32, init_value: 0 }, // 温度高高值
        { name: "temperature_WH", type: "Real", offset: 320, length: 32, init_value: 0 }, // 温度高值
        { name: "temperature_WL", type: "Real", offset: 352, length: 32, init_value: 0 }, // 温度低值
        { name: "temperature_AL", type: "Real", offset: 384, length: 32, init_value: 0 }, // 温度低低值
        { name: "temperature_DZ", type: "Real", offset: 416, length: 32, init_value: 0.5 }, // 温度比较死区
        { name: "temperature_FT", type: "UDInt", offset: 448, length: 32, init_value: 0 }, // 温度比较容错时间
        { name: "pressure_zero_raw", type: "Int", offset: 480, length: 16, init_value: 0 }, // 压力原始零点值
        { name: "pressure_span_raw", type: "Int", offset: 496, length: 16, init_value: 27648 }, // 压力原始量程值
        { name: "pressure_underflow", type: "Int", offset: 512, length: 16, init_value: -500 }, // 压力下溢出设置值
        { name: "pressure_overflow", type: "Int", offset: 528, length: 16, init_value: 28000 }, // 压力上溢出设置值
        { name: "pressure_zero", type: "Real", offset: 544, length: 32, init_value: 0 }, // 压力零点值
        { name: "pressure_span", type: "Real", offset: 576, length: 32, init_value: 4 }, // 压力量程值
        { name: "pressure_AH", type: "Real", offset: 608, length: 32, init_value: 0 }, // 压力高高值
        { name: "pressure_WH", type: "Real", offset: 640, length: 32, init_value: 0 }, // 压力高值
        { name: "pressure_WL", type: "Real", offset: 672, length: 32, init_value: 0 }, // 压力低值
        { name: "pressure_AL", type: "Real", offset: 704, length: 32, init_value: 0 }, // 压力低低值
        { name: "pressure_DZ", type: "Real", offset: 736, length: 32, init_value: 0.05 }, // 压力比较死区
        { name: "pressure_FT", type: "UDInt", offset: 768, length: 32, init_value: 0 }, // 压力比较容错时间
        { name: "flow1", type: "Real", offset: 800, length: 32, init_value: 0 }, // 流量1
        { name: "flow2", type: "Real", offset: 832, length: 32, init_value: 0 }, // 流量2
        { name: "flow3", type: "Real", offset: 864, length: 32, init_value: 0 }, // 流量3
        { name: "flow4", type: "Real", offset: 896, length: 32, init_value: 0 }, // 流量4
        { name: "flow5", type: "Real", offset: 928, length: 32, init_value: 0 }, // 流量5
        { name: "flow_smooth_factor", type: "Real", offset: 960, length: 32, init_value: 0.9 }, // 流量平滑权值
        { name: "equS1", type: "DInt", offset: 992, length: 32, init_value: 10000 }, // 流量1当量
        { name: "equS2", type: "DInt", offset: 1024, length: 32, init_value: 10000 }, // 流量2当量
        { name: "equS3", type: "DInt", offset: 1056, length: 32, init_value: 10000 }, // 流量3当量
        { name: "equS4", type: "DInt", offset: 1088, length: 32, init_value: 10000 }, // 流量4当量
        { name: "equS5", type: "DInt", offset: 1120, length: 32, init_value: 10000 }, // 流量5当量
        { name: "pump_change_delay", type: "UDInt", offset: 1152, length: 32, init_value: 180000 }, // 泵操作延时
    ]
};

export const command_code = {
    stop_pumps: 1,
    cancel_stop: 2,
    horn: 4,
    reset_horn: 8,
    enable_pressure_SD: 16,
    disable_pressure_SD: 32,
    read_paras: 64,
    write_paras: 128,
    enable_pressure_alarm: 256,
    disable_pressure_alarm: 512,
    enable_temperature_alarm: 1024,
    disable_temperature_alarm: 2048,
    reset_CPU: 4096,
    reset_conn: 8192,
    executing: 32768,
}
