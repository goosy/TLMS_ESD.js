export const node_commands = [
    { name: "stop_pumps", type: "Bool", offset: 0, length: 1, init_value: false }, // 停泵命令
    { name: "cancel_stop", type: "Bool", offset: 1, length: 1, init_value: false }, // 取消停泵
    { name: "horn", type: "Bool", offset: 2, length: 1, init_value: false }, // 输出报警
    { name: "reset_horn", type: "Bool", offset: 3, length: 1, init_value: false }, // 停止报警
    { name: "enable_pressure_SD", type: "Bool", offset: 4, length: 1, init_value: false }, // 设置压力联锁停泵
    { name: "disable_pressure_SD", type: "Bool", offset: 5, length: 1, init_value: false }, // 取消压力联锁停泵
    { name: "read_paras", type: "Bool", offset: 6, length: 1, init_value: false }, // 读取所有参数
    { name: "write_paras", type: "Bool", offset: 7, length: 1, init_value: false }, // 写参数命令
    { name: "enable_pressure_alarm", type: "Bool", offset: 8, length: 1, init_value: false }, // 允许压力报警
    { name: "disable_pressure_alarm", type: "Bool", offset: 9, length: 1, init_value: false }, // 禁止压力报警
    { name: "enable", type: "Bool", offset: 10, length: 1, init_value: false }, // 允许该节点工作
    { name: "disable", type: "Bool", offset: 11, length: 1, init_value: false }, // 禁止该节点工作
    { name: "reset_CPU", type: "Bool", offset: 12, length: 1, init_value: false }, // 重置CPU
    { name: "reset_conn", type: "Bool", offset: 13, length: 1, init_value: false }, // 重置连接
    { name: "executing", type: "Bool", offset: 15, length: 1, init_value: false }, // 正在执行
];

export const node_parameters = [
    { name: "temperature_zero_raw", type: "Int", offset: 0, length: 16, init_value: 0 }, //温度原始零点值
    { name: "temperature_span_raw", type: "Int", offset: 16, length: 16, init_value: 27648 }, //温度原始量程值
    { name: "temperature_underflow", type: "Int", offset: 32, length: 16, init_value: -500 }, //温度下溢出设置值
    { name: "temperature_overflow", type: "Int", offset: 48, length: 16, init_value: 28000 }, //温度上溢出设置值
    { name: "temperature_zero", type: "Real", offset: 64, length: 32, init_value: 0 }, //温度零点值
    { name: "temperature_span", type: "Real", offset: 96, length: 32, init_value: 100 }, //温度量程值
    { name: "temperature_AH", type: "Real", offset: 128, length: 32, init_value: 0 }, //温度高高值
    { name: "temperature_WH", type: "Real", offset: 160, length: 32, init_value: 0 }, //温度高值
    { name: "temperature_WL", type: "Real", offset: 192, length: 32, init_value: 0 }, //温度低值
    { name: "temperature_AL", type: "Real", offset: 224, length: 32, init_value: 0 }, //温度低低值
    { name: "temperature_DZ", type: "Real", offset: 256, length: 32, init_value: 0.5 }, //温度比较死区
    { name: "temperature_FT", type: "UDInt", offset: 288, length: 32, init_value: 0 }, //温度比较容错时间
    { name: "pressure_zero_raw", type: "Int", offset: 320, length: 16, init_value: 0 }, //压力原始零点值
    { name: "pressure_span_raw", type: "Int", offset: 336, length: 16, init_value: 27648 }, //压力原始量程值
    { name: "pressure_underflow", type: "Int", offset: 352, length: 16, init_value: -500 }, //压力下溢出设置值
    { name: "pressure_overflow", type: "Int", offset: 368, length: 16, init_value: 28000 }, //压力上溢出设置值
    { name: "pressure_zero", type: "Real", offset: 384, length: 32, init_value: 0 }, //压力零点值
    { name: "pressure_span", type: "Real", offset: 416, length: 32, init_value: 4 }, //压力量程值
    { name: "pressure_AH", type: "Real", offset: 448, length: 32, init_value: 0 }, //压力高高值
    { name: "pressure_WH", type: "Real", offset: 480, length: 32, init_value: 0 }, //压力高值
    { name: "pressure_WL", type: "Real", offset: 512, length: 32, init_value: 0 }, //压力低值
    { name: "pressure_AL", type: "Real", offset: 544, length: 32, init_value: 0 }, //压力低低值
    { name: "pressure_DZ", type: "Real", offset: 576, length: 32, init_value: 0.05 }, //压力比较死区
    { name: "pressure_FT", type: "UDInt", offset: 608, length: 32, init_value: 0 }, //压力比较容错时间
    { name: "reserve1", type: "Real", offset: 640, length: 32, init_value: 0 }, //预留1
    { name: "reserve2", type: "Real", offset: 672, length: 32, init_value: 0 }, //预留2
    { name: "reserve3", type: "Real", offset: 704, length: 32, init_value: 0 }, //预留3
    { name: "invalid_value_of_AI", type: "Real", offset: 736, length: 32, init_value: -100000.0 }, //模拟量无效时的预置值
    { name: "delay_protect_time", type: "UDInt", offset: 768, length: 32, init_value: 5000 }, //通讯中断延后挂起时间
    { name: "flow_smooth_factor", type: "Real", offset: 800, length: 32, init_value: 0.9 }, //流量平滑权值
    { name: "equS1", type: "DInt", offset: 832, length: 32, init_value: 10000 }, //流量1当量
    { name: "equS2", type: "DInt", offset: 864, length: 32, init_value: 10000 }, //流量2当量
    { name: "equS3", type: "DInt", offset: 896, length: 32, init_value: 10000 }, //流量3当量
    { name: "equS4", type: "DInt", offset: 928, length: 32, init_value: 10000 }, //流量4当量
    { name: "equS5", type: "DInt", offset: 960, length: 32, init_value: 10000 }, //流量5当量
    { name: "pump_change_delay", type: "UDInt", offset: 992, length: 32, init_value: 180000 }, //泵操作延时
];

export const command_code = { none: 0 };
for (const item of node_commands) {
    command_code[item.name] = 1 << item.offset;
}

function add_item(data_struct, item, base_offset, name_prefix) {
    const items = data_struct.items;
    if (items.find(_item => _item.name === item.name)) return; // @todo alarm or throw error
    if (item.name) items.push(item);
    if (name_prefix) item.name = name_prefix + item.name;

    item.offset = item.offset + base_offset;
    const length = item.offset + item.length;
    if (data_struct.length < length) data_struct.length = length;

    const includes = item.includes;
    if (includes && Array.isArray(includes)) {
        for (const _item of includes) {
            add_item(data_struct, { ..._item }, item.offset, item.name_prefix);
        }
        // The "includes" and "coupling" attributes can only be chosen one at a time.
        return;
    }

    const coupling = [];
    const _coupling = item.coupling;
    if (_coupling && Array.isArray(_coupling)) {
        for (const _cp of _coupling) {
            const cp = { ..._cp };
            add_item(data_struct, cp, item.offset, item.name_prefix);
            cp.coupling ??= [];
            cp.coupling.push(item.name);
            coupling.push(cp);
        }
    }
    item.coupling = coupling.map(item => item.name);
}

export function build_structure(data_struct, items) {
    data_struct.length = 0;
    data_struct.items = [];
    if (!items) return;
    for (const item of items) {
        add_item(data_struct, item, 0);
    }
    return data_struct;
}
