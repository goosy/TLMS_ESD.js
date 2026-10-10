// Generated from src/layouts.yaml. Do not edit.
import type { Ldata } from "modbus-emulator";
//
// In JavaScript, a JSDoc cast names the type of the value:
//   const data = /** @type {import("<this file>").LINE_Ldata} */ (new Ldata("LINE", "data_1"));

/** Tags of the LINE data block. */
export interface LINE_Tags {
	/** status word */
	status: number;
	/** Manual hang-up of the whole line */
	flow_override: boolean;
	/** Whether this line pumps */
	pump_run: boolean;
	/** Whether this line alarms */
	alarm_F: boolean;
	/** Auto stop command */
	autoStopCmd: boolean;
	/** Manual stop command */
	manStopCmd: boolean;
	/** Stop notice */
	pre_stop_notice: boolean;
	/** Line ID */
	ID: number;
	/** Section ID of the flow difference action */
	action_section_ID: number;
	/** Flow difference bypass (reserved, not implemented) */
	flow_diff: number;
}

/** A LINE data block, with its tags as properties. */
export type LINE_Ldata = Ldata & LINE_Tags;

/** Tags of the SECTION data block. */
export interface SECTION_Tags {
	/** Section ID */
	ID: number;
	/** Upward input area, writable by the upward clients (reserved) */
	upward_input: number;
	/** status word */
	status: number;
	/** Whether all nodes in this section communicate normally */
	comm_OK: boolean;
	/** Whether all nodes in this section work normally */
	work_OK: boolean;
	/** Whether this section is in protective mode */
	protect_F: boolean;
	/** Whether this section is automatically hung up */
	hangon_AF: boolean;
	/** Whether this section is manually hung up */
	flow_override: boolean;
	/** Whether this section is in the action of stopping the pump due to leakage */
	action_F: boolean;
	/** Whether this section is in the flow warning status */
	flow_warning_F: boolean;
	/** Whether this section is in the flow alarm status */
	flow_alarm_F: boolean;
	/** Whether this section is in the pressure warning status */
	press_warning_F: boolean;
	/** Whether this section is in the pressure alarm status */
	press_alarm_F: boolean;
	/** Whether this section is in the auto stop status */
	autoStopCmd: boolean;
	/** Whether this section is in the manual stop status */
	manStopCmd: boolean;
	/** Whether this section is the source of the line action */
	line_action_source: boolean;
	/** Whether this section has an open pump */
	pump_run: boolean;
	/** Whether there is a pump operation in the current time period */
	pump_change_F: boolean;
	/** Whether this section is in the pre-stop status */
	pre_stop_notice: boolean;
	/** Total flow of the starting node */
	flow_begin: number;
	/** Total flow of the ending node */
	flow_end: number;
	/** Flow difference */
	flow_diff: number;
	/** Flow warning difference upper limit */
	flow_diff_WH: number;
	/** Flow warning tolerance time (in milliseconds) */
	flow_diff_WH_delay: number;
	/** Flow difference alarm upper limit */
	flow_diff_AH: number;
	/** Flow alarm tolerance time (in milliseconds) */
	flow_diff_AH_delay: number;
	/** Linked action time (in milliseconds) */
	action_time: number;
	/** Linked action countdown (in seconds) */
	countdown: number;
	/** inner word */
	inner_word: number;
	/** Whether flow warning has been triggered */
	flow_warning_trigger: boolean;
	/** Whether flow alarm has been triggered */
	flow_alarm_trigger: boolean;
	/** Whether this section has executed stop pump */
	stop_pumps: boolean;
}

/** A SECTION data block, with its tags as properties. */
export type SECTION_Ldata = Ldata & SECTION_Tags;

/** Tags of the NODE data block. */
export interface NODE_Tags {
	ID: number;
	/** the status of the node */
	status: number;
	/** Used to maintain node communication status */
	comm_OK: boolean;
	/** Used to maintain node work status */
	work_OK: boolean;
	/** Is the pump running in this node? */
	pump_run: boolean;
	/** Whether the pump is in the delay of operation on this node */
	pump_change_F: boolean;
	/** Running status of pump 1 */
	pump_run_1: boolean;
	/** Running status of pump 2 */
	pump_run_2: boolean;
	/** Running status of pump 3 */
	pump_run_3: boolean;
	/** Running status of pump 4 */
	pump_run_4: boolean;
	/** Whether pressure alarm is enabled */
	pressure_enabled: boolean;
	/** Whether temperature alarm is enabled */
	temperature_enabled: boolean;
	/** Whether pressure linked to stop pump is enabled */
	pressure_SD_F: boolean;
	/** Whether communication interrupt delay protection is enabled */
	delay_protect: boolean;
	/** Whether pressure AH limit alarm is enabled */
	pressure_AH_F: boolean;
	/** Whether pressure WH limit alarm is enabled */
	pressure_WH_F: boolean;
	/** Whether pressure WL limit alarm is enabled */
	pressure_WL_F: boolean;
	/** Whether pressure AL limit alarm is enabled */
	pressure_AL_F: boolean;
	temperature: number;
	pressure: number;
	flowmeter: number;
	/** Execution response */
	response_code: number;
	/** Stop pump command */
	stop_pumps: boolean;
	/** Cancel stop pump */
	cancel_stop: boolean;
	/** Output alarm */
	horn: boolean;
	/** Stop alarm */
	reset_horn: boolean;
	/** Set pressure linked pump stop */
	enable_pressure_SD: boolean;
	/** Cancel pressure linked pump stop */
	disable_pressure_SD: boolean;
	/** Read all parameters */
	read_paras: boolean;
	/** Write parameter command */
	write_paras: boolean;
	/** Allow pressure alarm */
	enable_pressure_alarm: boolean;
	/** Disable pressure alarm */
	disable_pressure_alarm: boolean;
	/** Allow the node to work */
	enable: boolean;
	/** Disable the node */
	disable: boolean;
	/** Reset CPU */
	reset_CPU: boolean;
	/** Reset connection */
	reset_conn: boolean;
	/** Reserve */
	reserve: boolean;
	/** Executing */
	executing: boolean;
	/** Raw temperature zero point */
	temperature_zero_raw: number;
	/** Raw temperature range */
	temperature_span_raw: number;
	/** Temperature underflow setting value */
	temperature_underflow: number;
	/** Temperature overflow setting value */
	temperature_overflow: number;
	/** Temperature zero point */
	temperature_zero: number;
	/** Temperature range */
	temperature_span: number;
	/** Temperature AH value */
	temperature_AH: number;
	/** Temperature WH value */
	temperature_WH: number;
	/** Temperature WL value */
	temperature_WL: number;
	/** Temperature AL value */
	temperature_AL: number;
	/** Temperature comparison dead zone */
	temperature_DZ: number;
	/** Temperature comparison fault tolerance time */
	temperature_FT: number;
	/** Raw pressure zero point */
	pressure_zero_raw: number;
	/** Raw pressure range */
	pressure_span_raw: number;
	/** Pressure underflow setting value */
	pressure_underflow: number;
	/** Pressure overflow setting value */
	pressure_overflow: number;
	/** Pressure zero point */
	pressure_zero: number;
	/** Pressure range */
	pressure_span: number;
	/** Pressure AH value */
	pressure_AH: number;
	/** Pressure WH value */
	pressure_WH: number;
	/** Pressure WL value */
	pressure_WL: number;
	/** Pressure AL value */
	pressure_AL: number;
	/** Pressure comparison dead zone */
	pressure_DZ: number;
	/** Pressure comparison fault tolerance time */
	pressure_FT: number;
	/** Reserve 1 */
	reserve1: number;
	/** Reserve 2 */
	reserve2: number;
	/** Reserve 3 */
	reserve3: number;
	/** Value when AI is invalid */
	invalid_value_of_AI: number;
	/** Communication interrupt delay protection time */
	delay_protect_time: number;
	/** Flow smoothing factor */
	flow_smooth_factor: number;
	/** Flow 1 equivalent value */
	equS1: number;
	/** Flow 2 equivalent value */
	equS2: number;
	/** Flow 3 equivalent value */
	equS3: number;
	/** Flow 4 equivalent value */
	equS4: number;
	/** Flow 5 equivalent value */
	equS5: number;
	/** Pump operation delay */
	pump_change_delay: number;
}

/** A NODE data block, with its tags as properties. */
export type NODE_Ldata = Ldata & NODE_Tags;

/** Tags of the COMMAND data block. */
export interface COMMAND_Tags {
	/** No longer used */
	response_code: number;
	/** Response timeout setting (milliseconds) No longer used */
	overtime: number;
	/** Extended commands */
	extra_commands: number;
	/** Whether there are commands to be sent */
	has_commands: boolean;
	/** Reset the parameter values to the node parameter values */
	reset_paras: boolean;
	/** Node ID */
	ID: number;
	/** Commands */
	commands: number;
	/** Stop pump command */
	stop_pumps: boolean;
	/** Cancel stop pump */
	cancel_stop: boolean;
	/** Output alarm */
	horn: boolean;
	/** Stop alarm */
	reset_horn: boolean;
	/** Set pressure linked pump stop */
	enable_pressure_SD: boolean;
	/** Cancel pressure linked pump stop */
	disable_pressure_SD: boolean;
	/** Read all parameters */
	read_paras: boolean;
	/** Write parameter command */
	write_paras: boolean;
	/** Allow pressure alarm */
	enable_pressure_alarm: boolean;
	/** Disable pressure alarm */
	disable_pressure_alarm: boolean;
	/** Allow the node to work */
	enable: boolean;
	/** Disable the node */
	disable: boolean;
	/** Reset CPU */
	reset_CPU: boolean;
	/** Reset connection */
	reset_conn: boolean;
	/** Reserve */
	reserve: boolean;
	/** Executing */
	executing: boolean;
	/** Raw temperature zero point */
	temperature_zero_raw: number;
	/** Raw temperature range */
	temperature_span_raw: number;
	/** Temperature underflow setting value */
	temperature_underflow: number;
	/** Temperature overflow setting value */
	temperature_overflow: number;
	/** Temperature zero point */
	temperature_zero: number;
	/** Temperature range */
	temperature_span: number;
	/** Temperature AH value */
	temperature_AH: number;
	/** Temperature WH value */
	temperature_WH: number;
	/** Temperature WL value */
	temperature_WL: number;
	/** Temperature AL value */
	temperature_AL: number;
	/** Temperature comparison dead zone */
	temperature_DZ: number;
	/** Temperature comparison fault tolerance time */
	temperature_FT: number;
	/** Raw pressure zero point */
	pressure_zero_raw: number;
	/** Raw pressure range */
	pressure_span_raw: number;
	/** Pressure underflow setting value */
	pressure_underflow: number;
	/** Pressure overflow setting value */
	pressure_overflow: number;
	/** Pressure zero point */
	pressure_zero: number;
	/** Pressure range */
	pressure_span: number;
	/** Pressure AH value */
	pressure_AH: number;
	/** Pressure WH value */
	pressure_WH: number;
	/** Pressure WL value */
	pressure_WL: number;
	/** Pressure AL value */
	pressure_AL: number;
	/** Pressure comparison dead zone */
	pressure_DZ: number;
	/** Pressure comparison fault tolerance time */
	pressure_FT: number;
	/** Reserve 1 */
	reserve1: number;
	/** Reserve 2 */
	reserve2: number;
	/** Reserve 3 */
	reserve3: number;
	/** Value when AI is invalid */
	invalid_value_of_AI: number;
	/** Communication interrupt delay protection time */
	delay_protect_time: number;
	/** Flow smoothing factor */
	flow_smooth_factor: number;
	/** Flow 1 equivalent value */
	equS1: number;
	/** Flow 2 equivalent value */
	equS2: number;
	/** Flow 3 equivalent value */
	equS3: number;
	/** Flow 4 equivalent value */
	equS4: number;
	/** Flow 5 equivalent value */
	equS5: number;
	/** Pump operation delay */
	pump_change_delay: number;
}

/** A COMMAND data block, with its tags as properties. */
export type COMMAND_Ldata = Ldata & COMMAND_Tags;

/** Tags of the RECORD data block. */
export interface RECORD_Tags {
	/** Year */
	year: number;
	/** Month */
	month: number;
	/** Day */
	day: number;
	/** Hour */
	hour: number;
	/** Minute */
	minute: number;
	/** Second */
	second: number;
	/** Section ID for action, 0 for no record */
	section_ID: number;
	/** Flow sum of the start node of the action section */
	flow_begin: number;
	/** Flow sum of the end node of the action section */
	flow_end: number;
	/** Flow difference of the action section */
	flow_diff: number;
	/** Pressure of node 1 of the action section */
	node1_press: number;
	/** Pressure of node 2 of the action section */
	node2_press: number;
	/** Pressure of node 3 of the action section */
	node3_press: number;
	/** Pressure of node 4 of the action section */
	node4_press: number;
	/** Node 1 ID of the action section */
	node1_ID: number;
	/** Node 2 ID of the action section */
	node2_ID: number;
	/** Node 3 ID of the action section */
	node3_ID: number;
	/** Node 4 ID of the action section */
	node4_ID: number;
	/** status */
	status: number;
	/** Pressure exceeds the limit and takes action */
	press_action: boolean;
	/** Flow difference exceeds the limit and takes action */
	flow_action: boolean;
	/** Node 1 of the action section has an open pump */
	node1_pump_run: boolean;
	/** Node 2 of the action section has an open pump */
	node2_pump_run: boolean;
	/** Node 3 of the action section has an open pump */
	node3_pump_run: boolean;
	/** Node 4 of the action section has an open pump */
	node4_pump_run: boolean;
	/** The reverse order of the record, 0 for the latest */
	index: number;
}

/** A RECORD data block, with its tags as properties. */
export type RECORD_Ldata = Ldata & RECORD_Tags;
