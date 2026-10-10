import { act, component_bits } from "./rules.js";

const TIME_TAGS = ["year", "month", "day", "hour", "minute", "second"];

/**
 * The rule showing the record selected by `index` (doc/design.md 10):
 * -1 clears the time, an index out of the records restores the previous one.
 *
 * @param {{data: import("modbus-emulator").Ldata, get: (index: number) => boolean}} action_record
 * @return {Object} An act rule.
 */
export function action_record_rule(action_record) {
	const { data } = action_record;
	const tags = data.layout.items.map((item) => item.name);
	let shown;
	return act({
		name: `${data.name} index`,
		reads: [[data, "index"]],
		// the record tags, the status word through its bits
		writes: tags.filter((tag) => component_bits(data.layout, tag).length === 0).map((tag) => [data, tag]),
		run: () => {
			const index = data.index;
			if (index === shown) return;
			if (index === -1) {
				for (const tag of TIME_TAGS) data[tag] = 0;
			} else if (!action_record.get(index)) {
				data.index = shown ?? -1;
				return;
			}
			shown = index;
		},
	});
}
