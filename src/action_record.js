import { access, writeFile, appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import csv_parser from "csv-parser";
import { TData } from "./typed_data/TData.js";
import { RECORD } from "./layouts.js";
import { logger } from "./util.js";

const HEADERS = RECORD.items
	.filter((field) => field.type.toLowerCase() !== "word" && field.name !== "index")
	.map((field) => field.name);
const boolean_fields = ["press_action", "flow_action", "node1_pump_run", "node2_pump_run", "node3_pump_run", "node4_pump_run"];
const number_fields = HEADERS.filter((field) => !boolean_fields.includes(field));
function convertTypes(row) {
	for (const field of number_fields) {
		const value = row[field];
		row[field] = value !== "" && value !== undefined ? Number.parseFloat(value) : null;
	}
	for (const field of boolean_fields) {
		row[field] = row[field] === "true";
	}
}

function set_current_time(tdata) {
	const d = new Date();
	tdata.year = d.getFullYear();
	tdata.month = d.getMonth() + 1;
	tdata.day = d.getDate();
	tdata.hour = d.getHours();
	tdata.minute = d.getMinutes();
	tdata.second = d.getSeconds();
}

export class Action_Record {
	records = [];
	records_size = 10;
	data;
	name;
	file;
	/**
	 * @param {string} name - The name of the record, and of its CSV file.
	 * @param {Object} [data_options] - Options of the record data block (detection, on_write).
	 */
	constructor(name, data_options) {
		this.name = name;
		this.file = `${name}.csv`;
		this.data = new TData(RECORD, name, data_options);
	}

	get(index) {
		const record = this.records[index];
		if (!record) return false;
		for (const key of HEADERS) {
			this.data[key] = record[key];
		}
		return true;
	}

	async init(filename) {
		this.file = filename ?? this.file;
		try {
			await access(this.file);
			logger.info(`action record file is set to ${this.file}.`);
		} catch {
			await writeFile(this.file, `${HEADERS.join(",")}\n`);
			logger.info(`Empty action record file ${this.file} is created and used.`);
		}
		await this.read_records_from_csv();
		this.data.on("change", (tagname, old_value, new_value) => {
			logger.debug(`${this.name}: ${tagname} ${old_value} => ${new_value}`);
		});
		// Initial index value
		if (this.records.length) {
			this.data.index = 0;
		} else {
			this.data.index = -1;
		}
	}

	read_records_from_csv() {
		return new Promise((resolve, reject) => {
			const records = this.records;
			records.length = 0;
			createReadStream(this.file)
				.pipe(csv_parser())
				.on("error", (error) => reject(error))
				.on("data", (row) => {
					// add record to records and ensure records' length does not exceed records_size
					if (records.unshift(row) > this.records_size) records.pop();
				})
				.on("end", () => {
					records.forEach(convertTypes);
					resolve(true);
				});
		});
	}

	/**
	 * Sets the fields of a new record and adds it.
	 *
	 * @param {Object<string, number|boolean>} fields - The record fields by tag name.
	 */
	async update_record(fields) {
		for (const [key, value] of Object.entries(fields)) {
			this.data[key] = value;
		}
		await this.add_record();
	}

	async add_record() {
		set_current_time(this.data);
		const record = {};
		for (const key of HEADERS) {
			record[key] = this.data[key];
		}
		// add record to records and ensure records' length does not exceed records_size
		if (this.records.unshift(record) > this.records_size) this.records.pop();
		this.data.index = 0;
		// append record to csv
		const row = HEADERS.map((key) => this.data[key]).join(",");
		await appendFile(this.file, `${row}\n`, { flags: "a" });
	}
}
