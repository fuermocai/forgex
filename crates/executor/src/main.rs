//! 可执行入口：从 stdin 读取 JSON 规格，向 stdout 写 JSON 结果。
//!
//! 使用 `process::exit` 是为了避免异常情况下仍有读取线程持有可能被孙进程
//! 占用的管道句柄，从而让调用方一直等待。正常路径下 execute 已经等待
//! 读取线程结束，这里只是兜底。

use std::io::Read;
use std::process;

fn main() {
    let mut input = String::new();
    if let Err(err) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("forgex-executor: 读取 stdin 失败: {err}");
        process::exit(2);
    }

    let output = forgex_executor::run_json(&input);
    println!("{output}");
    process::exit(0);
}
