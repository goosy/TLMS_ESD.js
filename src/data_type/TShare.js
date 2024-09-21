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

export const command_code = { none: 0 };
node_commands.forEach(item => {
    command_code[item.name] = 1 << item.offset;
});

export function complete_structure(data_struct) {
    data_struct.length = 0;
    if (!data_struct.items) return;
    const items = data_struct.items;
    const cps = [];
    for (const item of items) {
        const length = item.offset + item.length;
        const base_offset = item.offset;
        if (data_struct.length < length) data_struct.length = length;
        const coupling = item.coupling;
        if (coupling && Array.isArray(coupling)) {
            item.coupling = coupling.map(_cp => {
                const name = item.coupling_prefix ? item.coupling_prefix + _cp.name : _cp.name;
                const offset = _cp.offset + base_offset;
                const cp = { ..._cp, name, offset };
                cp.coupling ??= [];
                cp.coupling.push(item);
                return cp;
            });
        } else {
            item.coupling = [];
        }
        cps.push(...item.coupling);
    }
    items.push(...cps);
}