import { MAIN_PERIOD } from "./config.js";
import { line_init } from "./line_proc.js";
import { section_loop, section_init } from "./section_proc.js";
import { node_loop, node_init } from "./node_proc.js";
import { TData } from "./typed_data/TData.js";
import { LINE, SECTION, NODE, COMMAND } from "./layouts.js";
import { Unit_Map } from "./typed_data/server.js";
import { Scheduler } from "./scan.js";
import { act } from "./rules.js";
import { logger } from "./util.js";

/**
 * Wraps a main loop function as a rule run once per periodic tick
 * (doc/design-scan.md 10.2): the loop functions count one period per call,
 * so they must not run on triggered scans. The rule's ticker, started by
 * the first scan, tells a new tick by its count.
 */
function tick_rule(name, loop) {
	let last_count = 0;
	return act({
		name,
		run: (ticker) => {
			ticker.start();
			if (ticker.count === last_count) return;
			last_count = ticker.count;
			loop();
		},
	});
}

/**
 * Builds the runtime object graph of a prepared controller: the data blocks
 * of its lines, sections and nodes, their attachment to the upward unit map,
 * the event wiring of the *_init functions and the scan scheduler.
 *
 * @param {Object} controller - The controller returned by prepare_controller.
 * @param {Object} options
 * @param {(driver_info: Object) => {data_driver: Object, command_driver: Object}} options.get_drivers
 *     Returns the drivers of a node, shared between nodes on the same connection.
 * @param {{data: TData}} options.action_record - The action record of the controller.
 * @return {{unit_map: Unit_Map, scheduler: Scheduler, lines: Object[], sections: Object[], nodes: Object[],
 *     start: () => void, stop: () => void}}
 */
export function build_runtime(controller, { get_drivers, action_record }) {
	const unit_id_map = controller.modbus_server.unit_id;
	const unit_map = new Unit_Map();
	const scheduler = new Scheduler({
		period: MAIN_PERIOD,
		on_error: (error, source) => logger.error(`scan: ${source?.name ?? "unknown"}: ${error.message}`),
	});
	// immediate detection; every write then requests a scan (doc/design-scan.md 3.3)
	const data_options = { on_write: () => scheduler.request_scan() };
	const lines = [];
	const sections = [];
	const nodes = [];

	controller.action_record = action_record;
	unit_map.attach_unit(unit_id_map.action_records, action_record.data, 0);
	scheduler.add_data(action_record.data);

	const add_node = (node) => {
		const { data_driver, command_driver } = get_drivers(node.driver_info);
		node.data_driver = data_driver;
		node.command_driver = command_driver;
		node.scheduler = scheduler;

		// for controller side, do not use `node.driver_info.unit_id;`
		const name = node.name;
		const s_unit_id = unit_id_map[name];
		/** @type {import("./layout_types").Node_TData} */
		const data = new TData(NODE, name, data_options);
		node.data = data;
		unit_map.attach_unit(s_unit_id, data, 0);
		/** @type {import("./layout_types").Command_TData} */
		const command = new TData(COMMAND, name, data_options);
		node.command = command;
		unit_map.attach_unit(s_unit_id, command, 400);

		node_init(node);
		scheduler.add_data(data);
		scheduler.add_data(command);
		// the node data are read on periodic ticks and loaded when they arrive
		scheduler.add_binding(node.data_binding, node.data_payload);
		nodes.push(node);
	};

	for (const line of controller.lines) {
		/** @type {import("./layout_types").Line_TData} */
		const data = new TData(LINE, line.name, data_options);
		line.data = data;
		unit_map.attach_unit(unit_id_map[line.name], data, 0);
		line_init(line);
		scheduler.add_data(data);
		lines.push(line);
		for (const section of line.sections) {
			/** @type {import("./layout_types").Section_TData} */
			const data = new TData(SECTION, section.name, data_options);
			section.data = data;
			unit_map.attach_unit(unit_id_map[section.name], data, 0);
			for (const node of section.begin_nodes) add_node(node);
			for (const node of section.end_nodes) add_node(node);
			section_init(section);
			scheduler.add_data(data);
			sections.push(section);
		}
	}

	// the former main loop, sections before nodes, as coarse rules (doc/design-scan.md 10.2)
	for (const section of sections) {
		scheduler.add_rule(tick_rule(`section ${section.name} loop`, () => section_loop(section)));
	}
	for (const node of nodes) {
		scheduler.add_rule(tick_rule(`node ${node.name} loop`, () => node_loop(node)));
	}
	scheduler.prepare();

	const start = () => {
		// a first scan starts the tickers of the coarse rules
		scheduler.scan(false);
		scheduler.start();
	};
	const stop = () => scheduler.stop();

	return { unit_map, scheduler, lines, sections, nodes, start, stop };
}
