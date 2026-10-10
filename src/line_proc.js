import { act, derive } from "./rules.js";
import { logger } from "./util.js";

export function line_init(line) {
	const {
		ID,
		name,
		data,
	} = line;
	data.ID = ID;
	data.name = name;

	data.on("change", (tagname, old_value, new_value) => {
		logger.debug(`line_${name}: ${tagname} ${old_value} => ${new_value}`);
	});
	data.get("flow_override").on("change", (_, new_value) => {
		logger.info(`line ${name} changed flow_override status to ${new_value}`);
	});
}

/**
 * Declares the rules of a line (doc/design-scan.md 7.5), once the whole
 * object graph is built: they read the data blocks of the sections.
 *
 * @param {Object} line
 * @param {import("./scan.js").Scheduler} scheduler
 */
export function line_rules(line, scheduler) {
	const { name, data, sections } = line;
	// a line tag is the "or" of the given tags of all its sections
	const some = (tag, section_tags = [tag]) => {
		const reads = sections.flatMap((section) => section_tags.map((section_tag) => [section.data, section_tag]));
		scheduler.add_rule(derive({
			name: `line ${name} ${tag}`,
			reads,
			writes: [[data, tag]],
			run: () => { data[tag] = reads.some(([section_data, section_tag]) => section_data[section_tag]); },
		}));
	};
	some("pump_run");
	some("alarm_F", ["flow_alarm_F", "press_alarm_F"]);
	some("pre_stop_notice");
	// the stop commands are reset when all pumps of the line stop
	scheduler.add_rule(act({
		name: `line ${name} stop commands reset`,
		reads: [[data, "pump_run"]],
		writes: [[data, "autoStopCmd"], [data, "manStopCmd"]],
		run: () => {
			if (!scheduler.fell(data, "pump_run")) return;
			data.autoStopCmd = false;
			data.manStopCmd = false;
			logger.info(`line ${name}: reset autoStopCmd and manStopCmd`);
		},
	}));
}
