import { MAIN_PERIOD } from "./config.js";
import { line_init } from "./line_proc.js";
import { section_loop, section_init } from "./section_proc.js";
import { node_loop, node_init } from "./node_proc.js";
import { TData } from "./typed_data/TData.js";
import { LINE, SECTION, NODE, COMMAND } from "./layouts.js";
import { Unit_Map } from "./typed_data/server.js";

/**
 * Builds the runtime object graph of a prepared controller: the data blocks
 * of its lines, sections and nodes, their attachment to the upward unit map
 * and the event wiring of the *_init functions.
 *
 * @param {Object} controller - The controller returned by prepare_controller.
 * @param {Object} options
 * @param {(driver_info: Object) => {data_driver: Object, command_driver: Object}} options.get_drivers
 *     Returns the drivers of a node, shared between nodes on the same connection.
 * @param {{data: TData}} options.action_record - The action record of the controller.
 * @return {{unit_map: Unit_Map, lines: Object[], sections: Object[], nodes: Object[],
 *     cycle: () => void, start: () => void, stop: () => void}}
 */
export function build_runtime(controller, { get_drivers, action_record }) {
	const unit_id_map = controller.modbus_server.unit_id;
	const unit_map = new Unit_Map();
	const lines = [];
	const sections = [];
	const nodes = [];

	controller.action_record = action_record;
	unit_map.attach_unit(unit_id_map.action_records, action_record.data, 0);

	const add_node = (node) => {
		const { data_driver, command_driver } = get_drivers(node.driver_info);
		node.data_driver = data_driver;
		node.command_driver = command_driver;

		// for controller side, do not use `node.driver_info.unit_id;`
		const name = node.name;
		const s_unit_id = unit_id_map[name];
		/** @type {import("./layout_types").Node_TData} */
		const data = new TData(NODE, name);
		node.data = data;
		unit_map.attach_unit(s_unit_id, data, 0);
		/** @type {import("./layout_types").Command_TData} */
		const command = new TData(COMMAND, name);
		node.command = command;
		unit_map.attach_unit(s_unit_id, command, 400);

		node_init(node);
		nodes.push(node);
	};

	for (const line of controller.lines) {
		/** @type {import("./layout_types").Line_TData} */
		const data = new TData(LINE, line.name);
		line.data = data;
		unit_map.attach_unit(unit_id_map[line.name], data, 0);
		line_init(line);
		lines.push(line);
		for (const section of line.sections) {
			/** @type {import("./layout_types").Section_TData} */
			const data = new TData(SECTION, section.name);
			section.data = data;
			unit_map.attach_unit(unit_id_map[section.name], data, 0);
			for (const node of section.begin_nodes) add_node(node);
			for (const node of section.end_nodes) add_node(node);
			section_init(section);
			sections.push(section);
		}
	}

	// one iteration of the main loop
	const cycle = () => {
		// for (const line of lines) line_loop(line);
		for (const section of sections) section_loop(section);
		for (const node of nodes) node_loop(node);
	};

	let loop = null;
	const start = () => {
		if (loop) clearInterval(loop);
		loop = setInterval(cycle, MAIN_PERIOD);
	};
	const stop = () => {
		if (loop) clearInterval(loop);
		loop = null;
	};

	return { unit_map, lines, sections, nodes, cycle, start, stop };
}
