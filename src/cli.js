import { exec } from 'node:child_process';
import { basename, join } from 'node:path';
import mri from 'mri';
import pkg from '../package.json' with { type: 'json' };

const argv = mri(process.argv.slice(2), {
    boolean: ['help', 'version'],
    alias: {
        H: 'help',
        V: 'version',
        P: 'path',
    }
});
const [cmd = 'start', controller_name = 0] = argv._;
const acturator_names = argv._.slice(1);

const _path = argv.path ?? '.';
process.chdir(_path);
const work_path = process.cwd();
const module_path = import.meta.dirname;
const version = pkg.version;

function show_help() {
    console.log(`usage:

tlms [subcommand] [controller_name or acturator_name_list] [options]

subcommand 子命令:
  help                       打印本帮助
  start                      以当前目录下的配置文件运行TLMS，这是默认子命令
  stop                       结束当前目录配置文件所在的TLMS
  list                       显示有多少个pm2托管的进程，包括TLMS实例
  debug                      以当前目录下的配置文件运行TLMS，但不压入后台，用于调试
  emu                        启动一个临时的管道节点仿真器用来测试
  log                        显示日志
  flush                      清空log

controller_name or acturator_name_list:
  控制器名称或序号，或者是执行器名称列表。
  默认为 "0"，即在配置文件的第一个控制器。
  控制器只能有一个名称，用于 start stop 子命令后。
  执行器可以是多个名称，用空格分开，用于 emu 子命令后。

options:
--version     | -V | -v      显示版本号，会忽略任何 subcommand 子命令
--help        | -H           打印本帮助，会忽略任何 subcommand 子命令
--path        | -P           指示配置文件所在的目录，默认为 "."

例子:
tlms                      以当前目录下的配置文件运行
tlms start ./conf         以 ./conf 目录下的配置文件运行
tlms stop                 停止
tlms emu GD8 YA1 YA1 DY8  启动指定4个节点的仿真器
`);
}

if (argv.version) {
    console.log(`V${version}`);
} else if (argv.help) {
    show_help();
} else if (cmd === 'start') {
    process.env.TLMS = 'controller';
    exec(
        `pm2 start --name="tlms-${basename(work_path)}" "${join(module_path, 'main.js')}" -- ${controller_name}`,
        { cwd: work_path }
    );
} else if (cmd === 'stop') {
    exec(
        `pm2 delete "tlms-${basename(work_path)}"`,
        { cwd: work_path }
    );
} else if (cmd === 'list') {
    exec(`pm2 list`, (error, stdout, _) => {
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
} else if (cmd === 'emu') {
    process.argv = [process.argv[0], process.argv[1], ...acturator_names];
    import('./emulator.js');
} else if (cmd === 'log') {
    exec(`pm2 log`);
} else if (cmd === 'flush') {
    exec(`pm2 flush`);
} else {
    show_help();
}
