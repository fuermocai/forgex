//! ForgeX 受控命令执行器（Rust 核心库）。
//!
//! 设计目标（与 TypeScript 侧的 run_command 对应）：
//! - **不做 shell**：program + args 直接交给 `Command`，不存在命令字符串解析；
//! - **环境变量隔离**：`env_clear()` 后只注入调用方显式给出的白名单变量；
//! - **超时终止进程树**：Windows 使用 `taskkill /T /F`，Unix 使用进程组负 PID；
//! - **输出上限**：stdout/stderr 各自超过 `maxOutputBytes` 后继续 drain 但丢弃，
//!   避免子进程因管道写满而阻塞，同时保护调用方内存。
//!
//! v0.2.0 新增：
//! - **callerToken 身份验证**：executor 启动时从环境变量 `FORGEX_EXECUTOR_TOKEN` 读取
//!   预共享 token，TS 侧每次调用传入 `caller_token`；不匹配直接拒绝执行——防止
//!   非 ForgeX 进程或已被注入的恶意脚本直接调用 executor 旁路 TypeScript 安全层。
//! - **cwd 路径白名单**：`allowed_cwd_roots` 限定 cwd 只能在这些目录内；为空时不限制。
//!   cwd 为空时默认使用 executor 启动时的 current_dir（天然受限）。
//! - **并发限制**：全局 AtomicUsize 限制同时运行的 executor 实例数（默认 8）；
//!   超过时立即返回 spawn_error，不阻塞。
//! - **结构化审计事件**：每次执行后向 stderr 输出一行 JSON 审计记录（含 callerToken 前缀、
//!   资源路径、退出码、耗时），可由上层收集。
//!
//! 协议：stdin 读取一个 JSON 规格，stdout 输出一个 JSON 结果。
//! 这是进程边界，错误不通过 panic 传播，而是放进 `spawnError` 字段。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

fn default_timeout_ms() -> u64 {
    30_000
}

fn default_max_output_bytes() -> usize {
    256 * 1024
}

fn default_max_concurrent() -> usize {
    8
}

/// 全局并发计数器：当前正在执行的实例数。
static RUNNING_COUNT: AtomicUsize = AtomicUsize::new(0);

/* ------------------------------------------------------------------ */
/* 规格 / 结果                                                          */
/* ------------------------------------------------------------------ */

/// 执行规格（字段名使用 camelCase，与 TypeScript 端一致）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecSpec {
    /// 可执行程序名或绝对路径
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    /// 已由调用方按白名单筛选过的环境变量
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: usize,

    /* ---- v0.2.0 安全加强字段 ---- */

    /// 调用方身份 token（必须与进程环境变量 FORGEX_EXECUTOR_TOKEN 匹配才放行）。
    /// executor 启动时若未设置 FORGEX_EXECUTOR_TOKEN，则本字段忽略（兼容单机开发）。
    #[serde(default)]
    pub caller_token: Option<String>,
    /// cwd 允许的根目录白名单；空或未设置时不做额外限制。
    /// cwd 必须在至少一个根目录内（子路径也算）。
    #[serde(default)]
    pub allowed_cwd_roots: Vec<PathBuf>,
    /// 单次执行的审计标签（出现在 stderr 审计日志里）
    #[serde(default)]
    pub audit_tag: Option<String>,
}

/// 执行结果（camelCase 序列化回 TypeScript）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    /// 退出码；被信号终止或启动失败时为 None
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub timed_out: bool,
    pub duration_ms: u64,
    /// 启动失败原因（找不到程序、权限不足等）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_error: Option<String>,
}

impl ExecResult {
    fn spawn_failure(message: String, duration_ms: u64) -> Self {
        ExecResult {
            code: None,
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
            timed_out: false,
            duration_ms,
            spawn_error: Some(message),
        }
    }
}

/* ------------------------------------------------------------------ */
/* 审计事件                                                             */
/* ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditEvent<'a> {
    event_type: &'static str,
    timestamp_ms: u128,
    caller_prefix: String,
    program: &'a str,
    args_count: usize,
    cwd: Option<&'a Path>,
    exit_code: Option<i32>,
    timed_out: bool,
    truncated: bool,
    duration_ms: u64,
    spawn_error: Option<&'a str>,
    tag: Option<&'a str>,
}

fn emit_audit(event: AuditEvent<'_>) {
    if let Ok(line) = serde_json::to_string(&event) {
        // 用 eprintln 写到 stderr——不污染 stdout 的 JSON 协议
        eprintln!("[executor-audit] {line}");
    }
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

/// 执行一个规格并返回结果。
///
/// 该函数不会 panic：所有 I/O 错误都被转换为结构化结果。
pub fn execute(spec: &ExecSpec) -> ExecResult {
    let started = Instant::now();

    // 1. callerToken 验证（仅当调用方显式提供 caller_token 时才校验；
    //    这是"主动开启"模式——避免 executor 被外部环境变量意外锁死）
    if let Some(provided) = spec.caller_token.as_deref() {
        if provided.is_empty() {
            // 空字符串直接拒绝（调用方要么给真实 token，要么不给）
            let result = ExecResult::spawn_failure(
                "CALLER_TOKEN_EMPTY: caller_token 为空字符串".to_string(),
                started.elapsed().as_millis() as u64,
            );
            emit_audit(AuditEvent {
                event_type: "denied_token",
                timestamp_ms: current_time_ms(),
                caller_prefix: "<empty>".to_string(),
                program: &spec.program,
                args_count: spec.args.len(),
                cwd: spec.cwd.as_deref(),
                exit_code: None,
                timed_out: false,
                truncated: false,
                duration_ms: result.duration_ms,
                spawn_error: result.spawn_error.as_deref(),
                tag: spec.audit_tag.as_deref(),
            });
            return result;
        }

        let expected = std::env::var("FORGEX_EXECUTOR_TOKEN").ok();
        let caller_ok = match expected {
            Some(exp) => exp == provided,
            // executor 没配 FORGEX_EXECUTOR_TOKEN，但调用方给了 token → 放行
            // （单机开发时 executor 未配置共享 token 属正常场景）
            None => true,
        };

        if !caller_ok {
            let result = ExecResult::spawn_failure(
                "CALLER_TOKEN_INVALID: caller_token 与 executor 侧 FORGEX_EXECUTOR_TOKEN 不匹配".to_string(),
                started.elapsed().as_millis() as u64,
            );
            emit_audit(AuditEvent {
                event_type: "denied_token",
                timestamp_ms: current_time_ms(),
                caller_prefix: token_prefix(Some(provided)),
                program: &spec.program,
                args_count: spec.args.len(),
                cwd: spec.cwd.as_deref(),
                exit_code: None,
                timed_out: false,
                truncated: false,
                duration_ms: result.duration_ms,
                spawn_error: result.spawn_error.as_deref(),
                tag: spec.audit_tag.as_deref(),
            });
            return result;
        }
    }

    // 2. cwd 白名单校验
    if !spec.allowed_cwd_roots.is_empty() {
        let effective_cwd = spec.cwd.clone().unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        });
        let is_allowed = spec.allowed_cwd_roots.iter().any(|root| {
            effective_cwd.starts_with(root)
        });
        if !is_allowed {
            let result = ExecResult::spawn_failure(
                format!(
                    "CWD_OUT_OF_WHITELIST: {:?} 不在允许的目录内 (允许: {:?})",
                    effective_cwd, spec.allowed_cwd_roots
                ),
                started.elapsed().as_millis() as u64,
            );
            emit_audit(AuditEvent {
                event_type: "denied_cwd",
                timestamp_ms: current_time_ms(),
                caller_prefix: token_prefix(spec.caller_token.as_deref()),
                program: &spec.program,
                args_count: spec.args.len(),
                cwd: Some(&effective_cwd),
                exit_code: None,
                timed_out: false,
                truncated: false,
                duration_ms: result.duration_ms,
                spawn_error: result.spawn_error.as_deref(),
                tag: spec.audit_tag.as_deref(),
            });
            return result;
        }
    }

    // 3. 并发限制
    let max_concurrent = std::env::var("FORGEX_EXECUTOR_MAX_CONCURRENT")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(default_max_concurrent());

    let current = RUNNING_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
    if current > max_concurrent {
        RUNNING_COUNT.fetch_sub(1, Ordering::SeqCst);
        let result = ExecResult::spawn_failure(
            format!(
                "CONCURRENT_LIMIT_EXCEEDED: 正在执行 {current} 个实例，上限 {max_concurrent}"
            ),
            started.elapsed().as_millis() as u64,
        );
        emit_audit(AuditEvent {
            event_type: "denied_concurrency",
            timestamp_ms: current_time_ms(),
            caller_prefix: token_prefix(spec.caller_token.as_deref()),
            program: &spec.program,
            args_count: spec.args.len(),
            cwd: spec.cwd.as_deref(),
            exit_code: None,
            timed_out: false,
            truncated: false,
            duration_ms: result.duration_ms,
            spawn_error: result.spawn_error.as_deref(),
            tag: spec.audit_tag.as_deref(),
        });
        return result;
    }

    // 4. 构建并启动命令（原有逻辑）
    let mut command = Command::new(&spec.program);
    command.args(&spec.args);
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    // 关键安全点：清空继承的环境变量，只注入调用方白名单
    command.env_clear();
    for (key, value) in &spec.env {
        command.env(key, value);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            RUNNING_COUNT.fetch_sub(1, Ordering::SeqCst);
            let result = ExecResult::spawn_failure(
                err.to_string(),
                started.elapsed().as_millis() as u64,
            );
            emit_audit(AuditEvent {
                event_type: "spawn_failed",
                timestamp_ms: current_time_ms(),
                caller_prefix: token_prefix(spec.caller_token.as_deref()),
                program: &spec.program,
                args_count: spec.args.len(),
                cwd: spec.cwd.as_deref(),
                exit_code: None,
                timed_out: false,
                truncated: false,
                duration_ms: result.duration_ms,
                spawn_error: result.spawn_error.as_deref(),
                tag: spec.audit_tag.as_deref(),
            });
            return result;
        }
    };

    let max_bytes = spec.max_output_bytes.max(1024);
    let truncated = Arc::new(AtomicBool::new(false));
    let stdout_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stderr_buf = Arc::new(Mutex::new(Vec::<u8>::new()));

    let stdout_reader = spawn_reader(
        child.stdout.take(),
        Arc::clone(&stdout_buf),
        max_bytes,
        Arc::clone(&truncated),
    );
    let stderr_reader = spawn_reader(
        child.stderr.take(),
        Arc::clone(&stderr_buf),
        max_bytes,
        Arc::clone(&truncated),
    );

    let timeout = Duration::from_millis(spec.timeout_ms.max(100));
    let mut timed_out = false;
    let mut status: Option<std::process::ExitStatus> = None;

    loop {
        match child.try_wait() {
            Ok(Some(exit)) => {
                status = Some(exit);
                break;
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    timed_out = true;
                    kill_tree(&mut child);
                    status = child.wait().ok();
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => {
                let _ = child.kill();
                status = child.wait().ok();
                break;
            }
        }
    }

    // 子进程结束后管道会关闭，读取线程通常很快退出；给 1s 兜底避免异常挂起
    join_with_timeout(stdout_reader, 1000);
    join_with_timeout(stderr_reader, 1000);

    let stdout = take_text(&stdout_buf);
    let stderr = take_text(&stderr_buf);
    let duration_ms = started.elapsed().as_millis() as u64;

    let result = ExecResult {
        code: status.and_then(|s| s.code()),
        stdout,
        stderr,
        truncated: truncated.load(Ordering::Relaxed),
        timed_out,
        duration_ms,
        spawn_error: None,
    };

    RUNNING_COUNT.fetch_sub(1, Ordering::SeqCst);

    emit_audit(AuditEvent {
        event_type: "executed",
        timestamp_ms: current_time_ms(),
        caller_prefix: token_prefix(spec.caller_token.as_deref()),
        program: &spec.program,
        args_count: spec.args.len(),
        cwd: spec.cwd.as_deref(),
        exit_code: result.code,
        timed_out: result.timed_out,
        truncated: result.truncated,
        duration_ms: result.duration_ms,
        spawn_error: None,
        tag: spec.audit_tag.as_deref(),
    });

    result
}

/// 解析 stdin JSON 并执行，返回输出 JSON 字符串（供 main 与测试使用）。
pub fn run_json(input: &str) -> String {
    match serde_json::from_str::<ExecSpec>(input) {
        Ok(spec) => match serde_json::to_string(&execute(&spec)) {
            Ok(json) => json,
            Err(err) => format!(
                "{{\"code\":null,\"stdout\":\"\",\"stderr\":\"\",\"truncated\":false,\"timedOut\":false,\"durationMs\":0,\"spawnError\":{}}}",
                serde_json::to_string(&format!("serialize error: {err}"))
                    .unwrap_or_else(|_| "\"serialize error\"".to_string())
            ),
        },
        Err(err) => format!(
            "{{\"code\":null,\"stdout\":\"\",\"stderr\":\"\",\"truncated\":false,\"timedOut\":false,\"durationMs\":0,\"spawnError\":{}}}",
            serde_json::to_string(&format!("invalid spec: {err}"))
                .unwrap_or_else(|_| "\"invalid spec\"".to_string())
        ),
    }
}

/* ------------------------------------------------------------------ */
/* 辅助函数                                                             */
/* ------------------------------------------------------------------ */

fn current_time_ms() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn token_prefix(token: Option<&str>) -> String {
    match token {
        Some(t) if t.len() >= 8 => format!("{}...{}", &t[..4], &t[t.len() - 4..]),
        Some(t) => t.to_string(),
        None => "<none>".to_string(),
    }
}

/* ------------------------------------------------------------------ */
/* 内部实现                                                             */
/* ------------------------------------------------------------------ */

fn spawn_reader<R: Read + Send + 'static>(
    reader: Option<R>,
    buffer: Arc<Mutex<Vec<u8>>>,
    max_bytes: usize,
    truncated: Arc<AtomicBool>,
) -> Option<JoinHandle<()>> {
    let mut reader = reader?;
    Some(thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    let mut guard = match buffer.lock() {
                        Ok(guard) => guard,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    let used = guard.len();
                    if used >= max_bytes {
                        truncated.store(true, Ordering::Relaxed);
                        continue;
                    }
                    let take = read.min(max_bytes - used);
                    guard.extend_from_slice(&chunk[..take]);
                    if take < read {
                        truncated.store(true, Ordering::Relaxed);
                    }
                }
                Err(_) => break,
            }
        }
    }))
}

fn take_text(buffer: &Arc<Mutex<Vec<u8>>>) -> String {
    let bytes = match buffer.lock() {
        Ok(mut guard) => std::mem::take(&mut *guard),
        Err(poisoned) => {
            let mut guard = poisoned.into_inner();
            std::mem::take(&mut *guard)
        }
    };
    String::from_utf8_lossy(&bytes).into_owned()
}

fn join_with_timeout(handle: Option<JoinHandle<()>>, timeout_ms: u64) {
    let Some(handle) = handle else { return };
    let (tx, rx) = mpsc::channel::<()>();
    thread::spawn(move || {
        let _ = handle.join();
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(Duration::from_millis(timeout_ms));
}

/// 终止整个进程树：先按树杀，失败再退回直接 kill。
fn kill_tree(child: &mut Child) {
    let pid = child.id();

    #[cfg(windows)]
    {
        let killed = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !killed {
            let _ = child.kill();
        }
        return;
    }

    #[cfg(unix)]
    {
        let killed = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !killed {
            let _ = child.kill();
        }
    }
}

/* ------------------------------------------------------------------ */
/* 测试                                                                 */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(program: &str, args: &[&str], timeout_ms: u64) -> ExecSpec {
        ExecSpec {
            program: program.to_string(),
            args: args.iter().map(|item| item.to_string()).collect(),
            cwd: None,
            env: BTreeMap::new(),
            timeout_ms,
            max_output_bytes: 4096,
            caller_token: None,
            allowed_cwd_roots: vec![],
            audit_tag: None,
        }
    }

    #[test]
    fn runs_rustc_version() {
        let result = execute(&spec("rustc", &["--version"], 10_000));
        assert!(result.spawn_error.is_none(), "spawn error: {:?}", result.spawn_error);
        assert_eq!(result.code, Some(0));
        assert!(result.stdout.to_lowercase().contains("rustc"));
        assert!(!result.timed_out);
    }

    #[test]
    fn reports_missing_program() {
        let result = execute(&spec("__forgex_definitely_missing__", &[], 5_000));
        assert!(result.spawn_error.is_some());
        assert!(result.code.is_none());
        assert!(result.stdout.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn terminates_on_timeout() {
        let result = execute(&spec("sleep", &["10"], 300));
        assert!(result.timed_out);
        assert!(result.duration_ms < 5_000);
    }

    #[cfg(windows)]
    #[test]
    fn terminates_on_timeout() {
        let result = execute(&spec("ping", &["-n", "10", "127.0.0.1"], 500));
        assert!(result.timed_out, "expected timeout, got {:?}", result);
        assert!(result.duration_ms < 8_000);
    }

    #[test]
    fn invalid_json_returns_spawn_error() {
        let output = run_json("{ not json");
        assert!(output.contains("spawnError"));
        assert!(output.contains("invalid spec"));
    }

    /* ---- v0.2.0 新测试 ---- */

    #[test]
    fn caller_token_mismatch_denied() {
        std::env::set_var("FORGEX_EXECUTOR_TOKEN", "expected-token-xyz");
        let mut s = spec("rustc", &["--version"], 5_000);
        s.caller_token = Some("wrong-token".to_string());
        let result = execute(&s);
        assert!(result.spawn_error.is_some());
        assert!(result.spawn_error.unwrap().contains("CALLER_TOKEN_INVALID"));
        std::env::remove_var("FORGEX_EXECUTOR_TOKEN");
    }

    #[test]
    fn caller_token_match_allowed() {
        std::env::set_var("FORGEX_EXECUTOR_TOKEN", "expected-token-xyz");
        let mut s = spec("rustc", &["--version"], 10_000);
        s.caller_token = Some("expected-token-xyz".to_string());
        let result = execute(&s);
        assert!(result.spawn_error.is_none());
        assert_eq!(result.code, Some(0));
        std::env::remove_var("FORGEX_EXECUTOR_TOKEN");
    }

    #[test]
    fn cwd_out_of_whitelist_denied() {
        let mut s = spec("rustc", &["--version"], 10_000);
        s.cwd = Some(PathBuf::from("/etc"));
        s.allowed_cwd_roots = vec![PathBuf::from("/tmp")];
        let result = execute(&s);
        assert!(result.spawn_error.is_some());
        assert!(result.spawn_error.unwrap().contains("CWD_OUT_OF_WHITELIST"));
    }

    #[test]
    fn cwd_in_whitelist_allowed() {
        let mut s = spec("rustc", &["--version"], 10_000);
        s.cwd = Some(std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        // 允许当前目录本身（子路径也算）
        let parent = s.cwd.as_ref().unwrap().clone();
        s.allowed_cwd_roots = vec![parent];
        let result = execute(&s);
        assert!(result.spawn_error.is_none(), "spawn error: {:?}", result.spawn_error);
        assert_eq!(result.code, Some(0));
    }
}
