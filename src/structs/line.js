import { build_structure } from "./share.js";

const items = [
    {   // status word
        name: "status", type: "Word", offset: 0, length: 16, init_value: 0,
        is_combined: true, coupling: [
            { name: "bypass", type: "Bool", offset: 0, length: 1, init_value: false }, // 是否越站
            { name: "pump_run", type: "Bool", offset: 1, length: 1, init_value: false }, // 本线是否起泵输油
            { name: "alarm_F", type: "Bool", offset: 2, length: 1, init_value: false }, // 本线有报警
            { name: "autoStopCmd", type: "Bool", offset: 3, length: 1, init_value: false }, // 自动停输命令
            { name: "manStopCmd", type: "Bool", offset: 4, length: 1, init_value: false }, // 人工停输命令
            { name: "pre_stop_notice", type: "Bool", offset: 5, length: 1, init_value: false }, // 停泵预告
        ],
    },
    { name: "ID", type: "UInt", offset: 16, length: 16, init_value: 0 }, // 本线ID号
    { name: "action_section_ID", type: "UInt", offset: 32, length: 16, init_value: 0 }, // 大流差动作管段的段号
    { name: "flow_diff", type: "Real", offset: 48, length: 32, init_value: 0 }, // 越站流差（保留，不实现）
];

export const LINE = build_structure({
    name: "LINE",
}, items);
