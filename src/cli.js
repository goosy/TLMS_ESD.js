import { exec } from 'node:child_process';
import { join } from 'node:path';
import mri from 'mri';
import pkg from '../package.json' with { type: 'json' };

const argv = mri(process.argv.slice(2), {
    boolean: ['help', 'version'],
    alias: {
        help: ['H', 'h'],
        version: ['V', 'v'],
        path: 'P',
    }
});
const [cmd = 'help', controller_name = ''] = argv._;

const _path = argv.path ?? '.';
process.chdir(_path);
const work_path = process.cwd();
const module_path = import.meta.dirname;
const version = pkg.version;

function show_help() {
    console.log(`usage:

tlms [subcommand] [controller_name] [options]

subcommand:
  help                       Print this help message, this is the default subcommand
  start                      Run TLMS with the configuration file in the specified directory, 
                             terminating any previous TLMS instance before starting
  restart                    Alias for 'start', add this subcommand to reflect the literal meaning of restart
  stop                       Terminate the running TLMS instance
  list                       Display the number of pm2-managed processes, including TLMS instances
  debug                      Run TLMS with the configuration file in the specified directory,
                             but without pushing it to the background, used for debugging
  flush                      Clear logs

controller_name:
  Controller name or index.
  Default is "0", i.e., the first controller in the configuration file.
  Only one controller name can be specified, used after the 'start' or 'stop' subcommands.

options:
--version | -V | -v          Display version number, ignores any subcommand
--help    | -H | -h          Print this help message, ignores any subcommand
--path    | -P               Specify the directory containing the configuration file, default is "."

Examples:
tlms start                   Run the first controller with the configuration file in the current directory
tlms start TC                Run the TC controller with the configuration file in the current directory
tlms start --path ./conf     Run using the configuration file in the ./conf directory
tlms start TC --path ./conf  Specify both the controller name and configuration file path
tlms stop                    Stop

用法：

tlms [subcommand] [controller_name] [options]

subcommand 子命令:
  help                       打印本帮助，这是默认子命令
  start                      以指定目录下的配置文件运行TLMS，启动前会先中止上一个TLMS实例。
  restart                    start 的别名，增加这个别名是为了体现重启的字面含义。
  stop                       结束正在运行的TLMS实例
  list                       显示有多少个pm2托管的进程，包括TLMS实例
  debug                      以指定目录下的配置文件运行TLMS，但不压入后台，用于调试
  flush                      清空log

controller_name:
  控制器名称或序号。
  默认为 "0"，即在配置文件的第一个控制器。
  控制器只能有一个名称，用于 start stop 子命令后。

options:
--version | -V | -v          显示版本号，会忽略任何 subcommand 子命令
--help    | -H | -h          打印本帮助，会忽略任何 subcommand 子命令
--path    | -P               指示配置文件所在的目录，默认为 "."

例子:
tlms start                   以当前目录下的配置文件运行第1个控制器
tlms start TC                以当前目录下的配置文件运行 TC 控制器
tlms start --path ./conf     以 ./conf 目录下的配置文件运行
tlms start TC --path ./conf  同时指定控制器名称和配置文件路径
tlms stop                    停止
`);
}

if (argv.version) {
    console.log(`V${version}`);
} else if (argv.help) {
    show_help();
} else if (cmd === 'start' || cmd === 'restart') {
    process.env.TLMS = 'controller';
	const main_js = join(module_path, 'main.js').replace(/\\/g, '/');
    const main_para = controller_name ? `-- ${controller_name}` : '';
    exec('pm2 delete "tlms_esd"', () => exec(
        `pm2 start --name="tlms_esd" "${main_js}" ${main_para}`,
        { cwd: work_path }
    ));
} else if (cmd === 'stop') {
    exec('pm2 delete "tlms_esd"');
} else if (cmd === 'list') {
    exec('pm2 list', (error, stdout, _) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return;
        }
        console.log(stdout);
    });
} else if (cmd === 'debug') {
    process.argv[2] = controller_name;
    process.env.LOG_LEVEL = 'debug';
    import('./main.js');
} else if (cmd === 'log') {
    exec('pm2 log');
} else if (cmd === 'flush') {
    exec('pm2 flush');
} else {
    show_help();
}
