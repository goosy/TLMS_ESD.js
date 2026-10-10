import { MAIN_PERIOD } from "./config.js";
import { line_init, line_rules } from "./line_proc.js";
import { section_init, section_rules } from "./section_proc.js";
import { node_init, node_mask_rule, node_rules } from "./node_proc.js";
import { action_record_rule } from "./action_record_proc.js";
import { Scheduler } from "./scan.js";
import { logger } from "./util.js";

/**
 * Builds the runtime object graph of a prepared controller: takes the data blocks
 * of its lines, sections and nodes from the upward emulator (create_upward),
 * the event wiring of the *_init functions, the scan scheduler and its rules.
 *
 * @param {Object} controller - The controller returned by prepare_controller.
 * @param {Object} options
 * @param {(driver_info: Object) => {data_driver: Object, command_driver: Object}} options.get_drivers
 *     Returns the drivers of a node, shared between nodes on the same connection.
 * @param {import("modbus-emulator").Modbus_Emulator} options.emulator
 *     The upward emulator of the controller, holding the data blocks.
 * @param {{data: import("modbus-emulator").Ldata, get: (index: number) => boolean, update_record: (fields: Object) => void}} options.action_record
 *     The action record of the controller.
 * @return {{scheduler: Scheduler, lines: Object[], sections: Object[], nodes: Object[],
 *     start: () => void, stop: () => void}}
 */
export function build_runtime(controller, { get_drivers, action_record, emulator }) {
	const scheduler = new Scheduler({
		period: MAIN_PERIOD,
		on_error: (error, source) => logger.error(`scan: ${source?.name ?? "unknown"}: ${error.message}`),
	});
	const lines = [];
	const sections = [];
	const nodes = [];

	controller.action_record = action_record;
	scheduler.add_data(action_record.data);

	const add_node = (node) => {
		const { data_driver, command_driver } = get_drivers(node.driver_info);
		node.data_driver = data_driver;
		node.command_driver = command_driver;
		node.scheduler = scheduler;

		/** @type {import("./layout_types").NODE_Ldata} */
		const data = emulator.block(node.block);
		node.data = data;
		/** @type {import("./layout_types").COMMAND_Ldata} */
		const command = emulator.block(node.command_block);
		node.command = command;

		node_init(node);
		scheduler.add_data(data);
		scheduler.add_data(command);
		// the node data are read on periodic ticks and loaded when they arrive;
		// the commands are only written (doc/design.md 5.5)
		scheduler.add_binding(node.data_binding, node.data_payload);
		scheduler.add_binding(node.command_binding);
		nodes.push(node);
	};

	for (const line of controller.lines) {
		/** @type {import("./layout_types").LINE_Ldata} */
		const data = emulator.block(line.block);
		line.data = data;
		line_init(line);
		scheduler.add_data(data);
		lines.push(line);
		for (const section of line.sections) {
			/** @type {import("./layout_types").SECTION_Ldata} */
			const data = emulator.block(section.block);
			section.data = data;
			for (const node of section.begin_nodes) add_node(node);
			for (const node of section.end_nodes) add_node(node);
			section_init(section);
			scheduler.add_data(data);
			sections.push(section);
		}
	}

	// rules are declared once the whole graph is built, nodes, sections, then
	// lines (doc/design.md 6.4)
	for (const node of nodes) node_rules(node, scheduler);
	for (const section of sections) section_rules(section, scheduler);
	for (const line of lines) line_rules(line, scheduler);
	scheduler.add_rule(action_record_rule(action_record));
	// the command masks after every other writer of the command bits (doc/design.md 14.1)
	for (const node of nodes) node_mask_rule(node, scheduler);
	scheduler.prepare();

	const start = () => {
		// a first scan computes the derived values
		scheduler.scan(false);
		scheduler.start();
	};
	const stop = () => scheduler.stop();

	return { scheduler, lines, sections, nodes, start, stop };
}
