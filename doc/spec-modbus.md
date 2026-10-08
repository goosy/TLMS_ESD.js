# TLMS_ESD Modbus Point Table

> English version of [spec-modbus.zh-cn.md](spec-modbus.zh-cn.md), the primary Chinese version. When the two differ, update both.
>
> This document is a sub-document of [spec.md](spec.md) and describes all the points the HMI/SCADA sees when it connects to the controller over Modbus TCP.
> The point table is generated from the definitions in `src/structs/`; where it differs from the code, the code prevails. The descriptions follow `data_structure2025.xlsx`, and the terms follow section 3 of [spec.md](spec.md).

## 1. Access conventions

- The controller offers the Modbus TCP service on `controller.modbus_server.port` (listening on `0.0.0.0`).
- Each line, each section, each actuator and the action record take one unit id each: the unit id of a line, section or actuator is its ID (see [spec.md](spec.md) 4.1), and the action record is fixed at unit id 0.
- Addresses within a unit all start at 0:
  - line, section and action record units: the data block starts at register 0;
  - actuator units: the node data block starts at register 0, the command block at register 200.
- Holding registers and input registers have the same content; registers are readable and writable, and the controller processes a write as a change immediately.
- Multi-register values (`Real`, `DInt`, `UDInt`) are big-endian, the high word at the lower address (ABCD order).
- Bit addresses are written `register.bit`, bit 0 being the lowest bit of the register. E.g. `1.0` is the lowest bit of register 1.
- Coils: each Bool can also be accessed as a coil, coil address = byte offset x 8 + bit. The tables give the coil addresses within the data block; the command block as a whole starts at register 200, so 3200 must be added to access its coils.
- "Initial" in the tables is the value at controller startup. The `ID` of lines, sections and actuators, and the limits, delays and `action_time` of sections are overwritten by the configuration at startup; the node data block is overwritten by the values reported by the actuator once connected.

## 2. Line (LINE, 5 registers)

| Register | Coil | Name | Type | Initial | Description |
| --- | --- | --- | --- | --- | --- |
| 0 |  | status | Word | 0 | Line status word |
| 0.0 | 8 | bypass | Bool | false | Whether bypassed |
| 0.1 | 9 | pump_run | Bool | false | Whether this line has pumps running |
| 0.2 | 10 | alarm_F | Bool | false | This line has an alarm |
| 0.3 | 11 | autoStopCmd | Bool | false | Automatic shutdown command |
| 0.4 | 12 | manStopCmd | Bool | false | Manual shutdown command |
| 0.5 | 13 | pre_stop_notice | Bool | false | Stop pump notice |
| 1 |  | ID | UInt | 0 | ID of this line |
| 2 |  | action_section_ID | UInt | 0 | Section number of the section of the large flow difference action |
| 3 |  | flow_diff | Real | 0 | Bypass flow difference (reserved, not implemented) |

## 3. Section (SECTION, 21 registers)

| Register | Coil | Name | Type | Initial | Description |
| --- | --- | --- | --- | --- | --- |
| 0 |  | ID | UInt | 0 | Section number |
| 1 |  | bypass_word | Word | 0 | Bypass word |
| 1.0 | 24 | bypass | Bool | false | This section is overridden |
| 2 |  | status | Word | 0 | Section status word |
| 2.0 | 40 | comm_OK | Bool | false | Communication of all actuators of this section is OK |
| 2.1 | 41 | work_OK | Bool | false | All actuators of this section work properly |
| 2.2 | 42 | protect_F | Bool | false | This section is in the protection state |
| 2.3 | 43 | hangon_AF | Bool | false | This section is hung on automatically |
| 2.4 | 44 | hangon_MF | Bool | false | This section is hung on manually |
| 2.5 | 45 | action_F | Bool | false | Whether this section stopped pumps on leakage |
| 2.6 | 46 | flow_warning_F | Bool | false | Flow warning of this section |
| 2.7 | 47 | flow_alarm_F | Bool | false | Flow alarm of this section (pre-action) |
| 2.8 | 32 | press_warning_F | Bool | false | Pressure warning of this section |
| 2.9 | 33 | press_alarm_F | Bool | false | Pressure alarm of this section (pre-action) |
| 2.10 | 34 | autoStopCmd | Bool | false | Automatic pump stop of this section |
| 2.11 | 35 | manStopCmd | Bool | false | Manual pump stop of this section |
| 2.12 | 36 | line_action_source | Bool | false | Whether this section is the source of the whole-line shutdown |
| 2.13 | 37 | pump_run | Bool | false | Whether this section has pumps running |
| 2.14 | 38 | pump_change_F | Bool | false | Whether a pump operation is in progress in the current period |
| 2.15 | 39 | pre_stop_notice | Bool | false | This section is about to stop pumps |
| 3 |  | flow_begin | Real | 0 | Total flow of the begin actuators |
| 5 |  | flow_end | Real | 0 | Total flow of the end actuators |
| 7 |  | flow_diff | Real | 0 | Flow difference |
| 9 |  | flow_diff_WH | Real | 20 | Flow difference warning upper limit |
| 11 |  | flow_diff_WH_delay | DInt | 3000 | Flow warning tolerance time (ms) |
| 13 |  | flow_diff_AH | Real | 50 | Flow difference alarm upper limit (action) |
| 15 |  | flow_diff_AH_delay | DInt | 3000 | Flow alarm tolerance time (ms) |
| 17 |  | action_time | DInt | 60000 | Interlock action time (ms) |
| 19 |  | countdown | Int | 0 | Interlock action countdown (s) |
| 20 |  | inner_word | Word | 0 | Internal bit word |
| 20.0 | 328 | flow_warning_trigger | Bool | false | Flow triggers a warning |
| 20.1 | 329 | flow_alarm_trigger | Bool | false | Flow triggers an alarm |
| 20.3 | 331 | stop_pumps | Bool | false | This section executes a pump stop |

`inner_word` holds trigger bits used inside the controller; the HMI only needs to read them.

## 4. Node data block (NODE, 73 registers, from register 0 of the actuator unit)

The node data block comes from the actuator; the controller reads it periodically and publishes it. `comm_OK` and `work_OK` are maintained by the controller according to the communication.

| Register | Coil | Name | Type | Initial | Description |
| --- | --- | --- | --- | --- | --- |
| 0 |  | ID | UInt | 0 | Actuator ID |
| 1 |  | status | Word | 3 | Actuator status word |
| 1.0 | 24 | comm_OK | Bool | true | Maintains the communication state of the actuator |
| 1.1 | 25 | work_OK | Bool | true | Maintains the working state of the actuator |
| 1.2 | 26 | pump_run | Bool | false | This actuator has a pump running |
| 1.3 | 27 | pump_change_F | Bool | false | Whether this actuator is in the pump operation delay |
| 1.4 | 28 | pump_run_1 | Bool | false | Running state of pump 1 |
| 1.5 | 29 | pump_run_2 | Bool | false | Running state of pump 2 |
| 1.6 | 30 | pump_run_3 | Bool | false | Running state of pump 3 |
| 1.7 | 31 | pump_run_4 | Bool | false | Running state of pump 4 |
| 1.8 | 16 | pressure_enabled | Bool | false | Pressure alarm enabled |
| 1.9 | 17 | temperature_enabled | Bool | false | Temperature alarm enabled |
| 1.10 | 18 | pressure_SD_F | Bool | false | Pressure interlock shutdown allowed flag |
| 1.11 | 19 | delay_protect | Bool | true | Delay protection (not used for now) |
| 1.12 | 20 | pressure_AH_F | Bool | false | Pressure high-high flag |
| 1.13 | 21 | pressure_WH_F | Bool | false | Pressure high flag |
| 1.14 | 22 | pressure_WL_F | Bool | false | Pressure low flag |
| 1.15 | 23 | pressure_AL_F | Bool | false | Pressure low-low flag |
| 2 |  | temperature | Real | 0 | Temperature value |
| 4 |  | pressure | Real | 0 | Pressure value |
| 6 |  | flowmeter | Real | 0 | Flow value |
| 8 |  | response_code | Word | 0 | Execution acknowledgement (bits as in the command word, a set bit means the command has been executed) (G5 needs no response code, should become UDInt) |
| 8.0 | 136 | stop_pumps | Bool | false | Stop pump command (acknowledgement bit) |
| 8.1 | 137 | cancel_stop | Bool | false | Cancel stop (acknowledgement bit) |
| 8.2 | 138 | horn | Bool | false | Output alarm (acknowledgement bit) |
| 8.3 | 139 | reset_horn | Bool | false | Stop alarm (acknowledgement bit) |
| 8.4 | 140 | enable_pressure_SD | Bool | false | Set pressure interlock pump stop (acknowledgement bit) |
| 8.5 | 141 | disable_pressure_SD | Bool | false | Cancel pressure interlock pump stop (acknowledgement bit) |
| 8.6 | 142 | read_paras | Bool | false | Read all parameters (acknowledgement bit) (no longer actually sent) |
| 8.7 | 143 | write_paras | Bool | false | Write parameters command (acknowledgement bit) |
| 8.8 | 128 | enable_pressure_alarm | Bool | false | Enable pressure alarm (acknowledgement bit) |
| 8.9 | 129 | disable_pressure_alarm | Bool | false | Disable pressure alarm (acknowledgement bit) |
| 8.10 | 130 | enable | Bool | false | Allow the actuator to work (acknowledgement bit) |
| 8.11 | 131 | disable | Bool | false | Forbid the actuator to work (acknowledgement bit) |
| 8.12 | 132 | reset_CPU | Bool | false | Reset CPU (acknowledgement bit) |
| 8.13 | 133 | reset_conn | Bool | false | Reset connection (acknowledgement bit) |
| 8.14 | 134 | reserve | Bool | false | Reserved (acknowledgement bit) |
| 8.15 | 135 | executing | Bool | false | Command executing (acknowledgement bit) |
| 9 |  | temperature_zero_raw | Int | 0 | Temperature raw zero value |
| 10 |  | temperature_span_raw | Int | 27648 | Temperature raw span value |
| 11 |  | temperature_underflow | Int | -500 | Temperature underflow setting |
| 12 |  | temperature_overflow | Int | 28000 | Temperature overflow setting |
| 13 |  | temperature_zero | Real | 0 | Temperature zero value (as actually set) |
| 15 |  | temperature_span | Real | 100 | Temperature span value (as actually set) |
| 17 |  | temperature_AH | Real | 0 | Temperature high-high value |
| 19 |  | temperature_WH | Real | 0 | Temperature high value |
| 21 |  | temperature_WL | Real | 0 | Temperature low value |
| 23 |  | temperature_AL | Real | 0 | Temperature low-low value |
| 25 |  | temperature_DZ | Real | 0.5 | Temperature comparison dead zone |
| 27 |  | temperature_FT | UDInt | 0 | Temperature comparison tolerance time |
| 29 |  | pressure_zero_raw | Int | 0 | Pressure raw zero value |
| 30 |  | pressure_span_raw | Int | 27648 | Pressure raw span value |
| 31 |  | pressure_underflow | Int | -500 | Pressure underflow setting |
| 32 |  | pressure_overflow | Int | 28000 | Pressure overflow setting |
| 33 |  | pressure_zero | Real | 0 | Pressure zero value (as actually set) |
| 35 |  | pressure_span | Real | 4 | Pressure span value (as actually set) |
| 37 |  | pressure_AH | Real | 0 | Pressure high-high value |
| 39 |  | pressure_WH | Real | 0 | Pressure high value |
| 41 |  | pressure_WL | Real | 0 | Pressure low value |
| 43 |  | pressure_AL | Real | 0 | Pressure low-low value |
| 45 |  | pressure_DZ | Real | 0.05 | Pressure comparison dead zone |
| 47 |  | pressure_FT | UDInt | 0 | Pressure comparison tolerance time |
| 49 |  | reserve1 | Real | 0 | Reserved (formerly flow data) |
| 51 |  | reserve2 | Real | 0 | Reserved |
| 53 |  | reserve3 | Real | 0 | Reserved |
| 55 |  | invalid_value_of_AI | Real | -100000 | Preset value when an analog input is invalid (not implemented yet) |
| 57 |  | delay_protect_time | UDInt | 5000 | Delay before hang-on after a communication failure |
| 59 |  | flow_smooth_factor | Real | 0.9 | Flow smoothing weight |
| 61 |  | equS1 | DInt | 10000 | Flow 1 equivalent |
| 63 |  | equS2 | DInt | 10000 | Flow 2 equivalent |
| 65 |  | equS3 | DInt | 10000 | Flow 3 equivalent |
| 67 |  | equS4 | DInt | 10000 | Flow 4 equivalent |
| 69 |  | equS5 | DInt | 10000 | Flow 5 equivalent |
| 71 |  | pump_change_delay | UDInt | 180000 | Pump operation delay |

## 5. Command block (COMMAND, 74 registers, from register 200 of the actuator unit)

Registers 0-7 are the local area of the controller and are not exchanged with the actuator; from register 8 (`ID`, the command word, the parameter block) the block is exchanged with the command area of the actuator.

- Commands: the HMI sets the corresponding bit of the command word, the controller sends it to the actuator and clears it automatically on receiving the acknowledgement.
- Parameters: the parameter block initially equals the parameters reported by the actuator; after the HMI changes parameters it sets `write_paras`, and the controller writes the parameters back to the actuator.

| Register | Coil | Name | Type | Initial | Description |
| --- | --- | --- | --- | --- | --- |
| 0 |  | response_code | Word | 0 | Acknowledgement code after the actuator executes |
| 1 |  | overtime | Int | 5000 | Acknowledgement timeout setting (ms) |
| 3 |  | extra_commands | Word | 0 | Extended command word |
| 3.0 | 56 | has_commands | Bool | false | There are commands to send |
| 3.1 | 57 | reset_paras | Bool | false | Reset the command parameter values to the actuator parameter values (to be removed) |
| 8 |  | ID | UInt | 0 | Actuator ID |
| 9 |  | commands | Word | 0 | Command word |
| 9.0 | 152 | stop_pumps | Bool | false | Stop pump command |
| 9.1 | 153 | cancel_stop | Bool | false | Cancel stop |
| 9.2 | 154 | horn | Bool | false | Output alarm |
| 9.3 | 155 | reset_horn | Bool | false | Stop alarm |
| 9.4 | 156 | enable_pressure_SD | Bool | false | Set pressure interlock pump stop |
| 9.5 | 157 | disable_pressure_SD | Bool | false | Cancel pressure interlock pump stop |
| 9.6 | 158 | read_paras | Bool | false | Read all parameters (no longer actually sent) |
| 9.7 | 159 | write_paras | Bool | false | Write parameters command |
| 9.8 | 144 | enable_pressure_alarm | Bool | false | Enable pressure alarm |
| 9.9 | 145 | disable_pressure_alarm | Bool | false | Disable pressure alarm |
| 9.10 | 146 | enable | Bool | false | Allow the actuator to work |
| 9.11 | 147 | disable | Bool | false | Forbid the actuator to work |
| 9.12 | 148 | reset_CPU | Bool | false | Reset CPU |
| 9.13 | 149 | reset_conn | Bool | false | Reset connection |
| 9.14 | 150 | reserve | Bool | false | Reserved |
| 9.15 | 151 | executing | Bool | false | Command executing |
| 10 |  | temperature_zero_raw | Int | 0 | Temperature raw zero value |
| 11 |  | temperature_span_raw | Int | 27648 | Temperature raw span value |
| 12 |  | temperature_underflow | Int | -500 | Temperature underflow setting |
| 13 |  | temperature_overflow | Int | 28000 | Temperature overflow setting |
| 14 |  | temperature_zero | Real | 0 | Zero value |
| 16 |  | temperature_span | Real | 100 | Span value |
| 18 |  | temperature_AH | Real | 0 | High-high value |
| 20 |  | temperature_WH | Real | 0 | High value |
| 22 |  | temperature_WL | Real | 0 | Low value |
| 24 |  | temperature_AL | Real | 0 | Low-low value |
| 26 |  | temperature_DZ | Real | 0.5 | Temperature comparison dead zone |
| 28 |  | temperature_FT | UDInt | 0 | Temperature comparison tolerance time |
| 30 |  | pressure_zero_raw | Int | 0 | Pressure raw zero value |
| 31 |  | pressure_span_raw | Int | 27648 | Pressure raw span value |
| 32 |  | pressure_underflow | Int | -500 | Pressure underflow setting |
| 33 |  | pressure_overflow | Int | 28000 | Pressure overflow setting |
| 34 |  | pressure_zero | Real | 0 | Zero value |
| 36 |  | pressure_span | Real | 4 | Span value |
| 38 |  | pressure_AH | Real | 0 | High-high value |
| 40 |  | pressure_WH | Real | 0 | High value |
| 42 |  | pressure_WL | Real | 0 | Low value |
| 44 |  | pressure_AL | Real | 0 | Low-low value |
| 46 |  | pressure_DZ | Real | 0.05 | Pressure comparison dead zone |
| 48 |  | pressure_FT | UDInt | 0 | Pressure comparison tolerance time |
| 50 |  | reserve1 | Real | 0 | Reserved |
| 52 |  | reserve2 | Real | 0 | Reserved |
| 54 |  | reserve3 | Real | 0 | Reserved |
| 56 |  | invalid_value_of_AI | Real | -100000 | Preset value when an analog input is invalid (not implemented yet) |
| 58 |  | delay_protect_time | UDInt | 5000 | Delay before hang-on after a communication failure |
| 60 |  | flow_smooth_factor | Real | 0.9 | Flow smoothing weight |
| 62 |  | equS1 | DInt | 10000 | Flow 1 equivalent |
| 64 |  | equS2 | DInt | 10000 | Flow 2 equivalent |
| 66 |  | equS3 | DInt | 10000 | Flow 3 equivalent |
| 68 |  | equS4 | DInt | 10000 | Flow 4 equivalent |
| 70 |  | equS5 | DInt | 10000 | Flow 5 equivalent |
| 72 |  | pump_change_delay | UDInt | 180000 | Pump operation delay |

## 6. Action record (RECORD, 27 registers)

The data block shows one record. Write `index` to select the record to view: 0 is the latest, 1 the one before, and so on; `-1` means no record.

| Register | Coil | Name | Type | Initial | Description |
| --- | --- | --- | --- | --- | --- |
| 0 |  | year | Uint | 0 | Year |
| 1 |  | month | Uint | 0 | Month |
| 2 |  | day | Uint | 0 | Day |
| 3 |  | hour | Uint | 0 | Hour |
| 4 |  | minute | Uint | 0 | Minute |
| 5 |  | second | Uint | 0 | Second |
| 6 |  | section_ID | UInt | 0 | ID of the section that caused the action; 0 means no record yet |
| 7 |  | flow_begin | Real | 0 | Total flow of the begin actuators of the action section |
| 9 |  | flow_end | Real | 0 | Total flow of the end actuators of the action section |
| 11 |  | flow_diff | Real | 0 | Flow difference of the action section |
| 13 |  | node1_press | Real | 0 | Pressure of actuator 1 of the action section |
| 15 |  | node2_press | Real | 0 | Pressure of actuator 2 of the action section |
| 17 |  | node3_press | Real | 0 | Pressure of actuator 3 of the action section |
| 19 |  | node4_press | Real | 0 | Pressure of actuator 4 of the action section |
| 21 |  | node1_ID | UInt | 0 | ID of actuator 1 of the action section |
| 22 |  | node2_ID | UInt | 0 | ID of actuator 2 of the action section |
| 23 |  | node3_ID | UInt | 0 | ID of actuator 3 of the action section |
| 24 |  | node4_ID | UInt | 0 | ID of actuator 4 of the action section |
| 25 |  | status | Word | 0 | Action status word |
| 25.0 | 408 | press_action | Bool | false | Pressure over-limit action |
| 25.1 | 409 | flow_action | Bool | false | Flow difference over-limit action |
| 25.2 | 410 | node1_pump_run | Bool | false | Begin actuator 1 of the action section has a pump running |
| 25.3 | 411 | node2_pump_run | Bool | false | Begin actuator 2 of the action section has a pump running |
| 25.4 | 412 | node3_pump_run | Bool | false | Begin actuator 3 of the action section has a pump running |
| 25.5 | 413 | node4_pump_run | Bool | false | Begin actuator 4 of the action section has a pump running |
| 26 |  | index | Int | -1 | Which record from the last, 0 is the latest |

## 7. Differences from the 2025 point table (data_structure2025.xlsx)

The code prevails for the following differences, and this document follows the code:

| Location | 2025 point table | Code |
| --- | --- | --- |
| Length of the section data block | 22 registers, register 20 also holds `action_F_edge`, `stop_edge` | 21 registers, without these two bits |
| Node data block parameter area registers 55-58 | `reserve4` (Real), `delay_protect_time` (Real) | `invalid_value_of_AI` (Real), `delay_protect_time` (UDInt) |
| Node data block raw span / overflow initial values | 20000 / 20500 | 27648 / 28000 |
| Type of node data block `response_code` | UInt | Word (organized by command bits) |
| Command block parameter `delay_hangup` | Named `delay_hangup` | Named `delay_protect_time` |
| Action record status word | `node1..3_pump_run` | Also `node4_pump_run` |
