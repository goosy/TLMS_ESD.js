import { node_commands, node_parameters, build_structure } from "./share.js";

const items = [
    { name: "response_code", type: "Word", offset: 0, length: 16, init_value: 0 }, // 已无作用
    { name: "overtime", type: "Int", offset: 16, length: 16, init_value: 5000 }, // 应答超时设定(毫秒) 暂无作用
    {   // 扩展命令
        name: "extra_commands", type: "Word", offset: 48, length: 16, init_value: 0,
        is_combined: true, coupling: [
            { name: "has_commands", type: "Bool", offset: 0, length: 1, init_value: false }, // 当前有命令需要发送
            { name: "reset_paras", type: "Bool", offset: 1, length: 1, init_value: false }, // 将命令参数值重置为节点参数值
        ],
    },
    { name: "ID", type: "UInt", offset: 128, length: 16, init_value: 0 }, // 节点ID
    {   // 命令
        name: "commands", type: "Word", offset: 144, length: 16, init_value: 0,
        is_combined: true, coupling: node_commands,
    },
    { includes: node_parameters, offset: 160 },
];

export const COMMAND = build_structure({ name: "COMMAND" }, items);
