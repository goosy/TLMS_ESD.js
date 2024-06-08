export const NODE = {
    name: "NODE",
    length: 1184,
    items: [
        { name: "node_ID", type: "UInt", offset: 0, length: 16, init_value: 0 }, // 节点ID
        { name: "comm_OK", type: "Bool", offset: 16, length: 1, init_value: true }, // 用于维护节点通讯状态
        { name: "work_OK", type: "Bool", offset: 17, length: 1, init_value: true }, // 用于维护节点工作状态
        { name: "pump_run", type: "Bool", offset: 18, length: 1, init_value: false }, // 本节点有泵运行
        { name: "pump_change_F", type: "Bool", offset: 19, length: 1, init_value: false }, // 本节点是否处于泵操作延时
        { name: "pump_run_1", type: "Bool", offset: 20, length: 1, init_value: false }, // 1#泵运行状态
        { name: "pump_run_2", type: "Bool", offset: 21, length: 1, init_value: false }, // 2#泵运行状态
        { name: "pump_run_3", type: "Bool", offset: 22, length: 1, init_value: false }, // 3#泵运行状态
        { name: "pump_run_4", type: "Bool", offset: 23, length: 1, init_value: false }, // 4#泵运行状态
        { name: "enable_pressure_alarm", type: "Bool", offset: 24, length: 1, init_value: false }, // 压力允许报警
        { name: "enable_temperature_alarm", type: "Bool", offset: 25, length: 1, init_value: false }, // 温度允许报警
        { name: "pressure_SD_F", type: "Bool", offset: 26, length: 1, init_value: false }, // 压力允许联锁停输标志
        { name: "reserve", type: "Bool", offset: 27, length: 1, init_value: false }, // 预留
        { name: "pressure_AH_F", type: "Bool", offset: 28, length: 1, init_value: false }, // 压力上上限标志
        { name: "pressure_WH_F", type: "Bool", offset: 29, length: 1, init_value: false }, // 压力上限标志
        { name: "pressure_WL_F", type: "Bool", offset: 30, length: 1, init_value: false }, // 压力下限标志
        { name: "pressure_AL_F", type: "Bool", offset: 31, length: 1, init_value: false }, // 压力下下限标志
        { name: "temperature", type: "Real", offset: 32, length: 32, init_value: 0 }, // 温度值
        { name: "pressure", type: "Real", offset: 64, length: 32, init_value: 0 }, // 压力值
        { name: "flowmeter", type: "Real", offset: 96, length: 32, init_value: 0 }, // 流量值
        { name: "response_code", type: "DInt", offset: 128, length: 32, init_value: 0 }, // 执行应答
        { name: "temperature_zero_raw", type: "Int", offset: 160, length: 16, init_value: 0 }, // 模块原始零点值
        { name: "temperature_span_raw", type: "Int", offset: 176, length: 16, init_value: 27648 }, // 模块原始量程值
        { name: "temperature_underflow", type: "Int", offset: 192, length: 16, init_value: 500 }, // 模块下溢出设置值
        { name: "temperature_overflow", type: "Int", offset: 208, length: 16, init_value: 28000 }, // 模块上溢出设置值
        { name: "pressure_zero_raw", type: "Int", offset: 224, length: 16, init_value: 0 }, // 模块原始零点值
        { name: "pressure_span_raw", type: "Int", offset: 240, length: 16, init_value: 27648 }, // 模块原始量程值
        { name: "pressure_underflow", type: "Int", offset: 256, length: 16, init_value: 500 }, // 模块下溢出设置值
        { name: "pressure_overflow", type: "Int", offset: 272, length: 16, init_value: 28000 }, // 模块上溢出设置值
        { name: "temperature_zero", type: "Real", offset: 288, length: 32, init_value: 0 }, // 零点值
        { name: "temperature_span", type: "Real", offset: 320, length: 32, init_value: 100 }, // 量程值
        { name: "temperature_AH", type: "Real", offset: 352, length: 32, init_value: 0 }, // 高高值
        { name: "temperature_WH", type: "Real", offset: 384, length: 32, init_value: 0 }, // 高值
        { name: "temperature_WL", type: "Real", offset: 416, length: 32, init_value: 0 }, // 低值
        { name: "temperature_AL", type: "Real", offset: 448, length: 32, init_value: 0 }, // 低低值
        { name: "temperature_DZ", type: "Real", offset: 480, length: 32, init_value: 0.05 }, // 温度比较死区
        { name: "temperature_FT", type: "UDInt", offset: 512, length: 32, init_value: 0 }, // 温度比较容错时间
        { name: "pressure_zero", type: "Real", offset: 544, length: 32, init_value: 0 }, // 零点值
        { name: "pressure_span", type: "Real", offset: 576, length: 32, init_value: 4 }, // 量程值
        { name: "pressure_AH", type: "Real", offset: 608, length: 32, init_value: 0 }, // 高高值
        { name: "pressure_WH", type: "Real", offset: 640, length: 32, init_value: 0 }, // 高值
        { name: "pressure_WL", type: "Real", offset: 672, length: 32, init_value: 0 }, // 低值
        { name: "pressure_AL", type: "Real", offset: 704, length: 32, init_value: 0 }, // 低低值
        { name: "pressure_DZ", type: "Real", offset: 736, length: 32, init_value: 0.05 }, // 压力比较死区
        { name: "pressure_FT", type: "UDInt", offset: 768, length: 32, init_value: 0 }, // 压力比较容错时间
        { name: "flow1", type: "Real", offset: 800, length: 32, init_value: 0 }, // 流量1
        { name: "flow2", type: "Real", offset: 832, length: 32, init_value: 0 }, // 流量2
        { name: "flow3", type: "Real", offset: 864, length: 32, init_value: 0 }, // 流量3
        { name: "flow4", type: "Real", offset: 896, length: 32, init_value: 0 }, // 流量4
        { name: "flow5", type: "Real", offset: 928, length: 32, init_value: 0 }, // 流量5
        { name: "flow_smooth_factor", type: "Real", offset: 960, length: 32, init_value: 9 }, // 流量平滑权值
        { name: "equS1", type: "DInt", offset: 992, length: 32, init_value: 10000 }, // 流量1当量
        { name: "equS2", type: "DInt", offset: 1024, length: 32, init_value: 10000 }, // 流量2当量
        { name: "equS3", type: "DInt", offset: 1056, length: 32, init_value: 10000 }, // 流量3当量
        { name: "equS4", type: "DInt", offset: 1088, length: 32, init_value: 10000 }, // 流量4当量
        { name: "equS5", type: "DInt", offset: 1120, length: 32, init_value: 10000 }, // 流量5当量
        { name: "pump_change_delay", type: "UDInt", offset: 1152, length: 32, init_value: 180000 }, // 泵操作延时
    ]
};

























































