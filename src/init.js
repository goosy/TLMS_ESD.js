import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Modbus_Emulator } from "modbus-emulator";
import { cfg_lines, cfg_actuators, cfg_controllers } from "./config.js";
import { build_description, write_description } from "./description.js";
import { LAYOUT_SCOPE } from "./layouts.js";
import { logger } from "./util.js";

// the block name of the action records (doc/design.md 4.4)
const RECORD_NAME = "action_records";

function add_actuator(section, cfg_node) {
	const ID = cfg_node.id;
	const {
		name, IP,
		is_begin, is_end, has_pumps, command_mask,
	} = cfg_node;
	let driver_info = null;
	if (cfg_node.modbus_server) {
		driver_info = {
			...cfg_node.modbus_server,
			protocol: "modbusTCP",
			IP,
		};
	} else if (cfg_node.s7_server) {
		driver_info = {
			...cfg_node.s7_server,
			protocol: "S7",
			host: IP,
		};
	}

	const actuator = {
		ID, name,
		// the block name of the commands; the data block is named after the actuator
		command_name: `${name} command`,
		driver_info,
		is_begin, is_end, has_pumps, command_mask, section,
	};
	if (is_begin) section.begin_nodes.push(actuator);
	if (is_end) section.end_nodes.push(actuator);
	if (has_pumps) section.pump_nodes.push(actuator);
}

/**
 * Builds the object graph of a controller and names its data blocks: a line,
 * a section and an actuator name their data blocks (doc/design.md 4.4).
 */
async function prepare_controller(controller_name) {
	// if controller_name is '', '0', 0, null, undefined, or not given, use the first one
	const controller = controller_name === 0 || !controller_name
		? cfg_controllers[0]
		: cfg_controllers.find((c) => c.name === controller_name);
	// loose equality on purpose: the value may be null
	if (controller == undefined) {
		return null;
	}
	controller.record_name = RECORD_NAME;
	controller.lines = [];

	for (const cfg_line of cfg_lines) {
		if (cfg_line.controller.name !== controller.name) continue;
		const ID = cfg_line.id;
		const name = cfg_line.name;
		const line = { ID, name, controller, sections: [] };
		controller.lines.push(line);
		for (const cfg_section of cfg_line.sections) {
			const ID = cfg_section.id;
			const name = cfg_section.name;
			const flow_diff_WH = cfg_section.flow_diff_WH;
			const flow_diff_WH_delay = cfg_section.flow_diff_WH_delay;
			const flow_diff_AH = cfg_section.flow_diff_AH;
			const flow_diff_AH_delay = cfg_section.flow_diff_AH_delay;
			const action_time = cfg_section.action_time;

			const section = {
				ID,
				name,
				line,
				begin_nodes: [],
				end_nodes: [],
				pump_nodes: [],
				flow_diff_WH,
				flow_diff_WH_delay,
				flow_diff_AH,
				flow_diff_AH_delay,
				action_time,
			};
			for (const node_name of cfg_section.begin_nodes) {
				const cfg_node = cfg_actuators[node_name];
				cfg_node.is_begin = true;
				add_actuator(section, cfg_node);
			}
			for (const node_name of cfg_section.end_nodes) {
				const cfg_node = cfg_actuators[node_name];
				cfg_node.is_end = true;
				add_actuator(section, cfg_node);
			};
			line.sections.push(section);
		}
	}

	return controller;
}

/**
 * Builds a controller and its data blocks (doc/design.md 4.4): the object
 * graph, the emulator description written to `<dir>/<controller>/emulator.yaml`,
 * the emulator that loads it, and the data blocks mounted on the graph
 * (`data` of a line, a section and an actuator, `command` of an actuator,
 * `record_data` of the controller).
 *
 * @param {string} [controller_name] - The controller; the first one when empty.
 * @param {string} dir - The directory of the description file.
 * @return {Promise<{controller: Object, emulator: Modbus_Emulator} | undefined>}
 *     Undefined when there is no such controller. The emulator is not started.
 * @throws {Error} With `errors`, every violation found, when the description is not valid.
 */
export async function init_controller(controller_name, dir) {
	const controller = await prepare_controller(controller_name);
	if (!controller) return undefined;
	// the emulator of a controller keeps its files in a subdirectory named after the controller
	const emulator_dir = join(dir, controller.name);
	mkdirSync(emulator_dir, { recursive: true });
	const file = join(emulator_dir, "emulator.yaml");
	write_description(file, build_description(controller));

	const emulator = new Modbus_Emulator(LAYOUT_SCOPE);
	log_emulator(emulator);
	emulator.load(file);

	controller.record_data = emulator.block(controller.record_name);
	for (const line of controller.lines) {
		line.data = emulator.block(line.name);
		for (const section of line.sections) {
			section.data = emulator.block(section.name);
			for (const node of [...section.begin_nodes, ...section.end_nodes]) {
				node.data = emulator.block(node.name);
				node.command = emulator.block(node.command_name);
			}
		}
	}
	return { controller, emulator };
}

/** Writes the diagnostics and the server events of the emulator to the log. */
function log_emulator(emulator) {
	const peer = (socket) => `${socket.remoteAddress}:${socket.remotePort}`;
	emulator.on("warning", ({ message }) => logger.warn(message));
	emulator.on("server_start", ({ server }) => logger.info(`Modbus server listening on ${server.name}`));
	emulator.on("server_stop", ({ server }) => logger.info(`Modbus server ${server.name} stopped`));
	emulator.on("server_socket_connect", ({ socket }) => logger.info(`client connected: ${peer(socket)}`));
	emulator.on("server_socket_disconnect", ({ socket }) => logger.info(`client disconnected: ${peer(socket)}`));
	emulator.on("server_socket_error", ({ error }) => logger.error(`client error: ${error.message}`));
	emulator.on("server_error", ({ error }) => logger.error(`server error: ${error.message}`));
	emulator.on("server_handler_error", ({ error }) => logger.error(`server request failed: ${error.message}`));
	emulator.on("unmapped", ({ kind, unit_id, addr, operation }) => {
		logger.warn(`${operation} of unmapped ${kind} address ${addr} in unit ${unit_id}`);
	});
	emulator.on("unmapped_limit", ({ limit }) => {
		logger.warn(`${limit} unmapped addresses reported, further ones are not reported`);
	});
	emulator.on("listener_error", ({ block, error }) => {
		logger.error(`a listener of block ${block.name} failed: ${error instanceof Error ? error.message : error}`);
	});
}
