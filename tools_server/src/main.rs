use anyhow::{Context, Result};
use glob::glob;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use walkdir::WalkDir;

#[derive(Debug, Deserialize)]
struct RpcRequest {
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct RpcResponse {
    jsonrpc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcError>,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: i64,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ToolCallParams {
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Deserialize)]
struct MultiEdit {
    old: String,
    new: String,
}

fn main() -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let request: RpcRequest = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(err) => {
                let response = RpcResponse {
                    jsonrpc: "2.0",
                    id: None,
                    result: None,
                    error: Some(RpcError {
                        code: -32700,
                        message: format!("Parse error: {err}"),
                    }),
                };
                writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
                stdout.flush()?;
                continue;
            }
        };

        let response = handle_request(request);
        writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
        stdout.flush()?;
    }

    Ok(())
}

fn handle_request(request: RpcRequest) -> RpcResponse {
    let id = request.id.clone();
    if request.jsonrpc.as_deref() != Some("2.0") {
        return err_response(id, -32600, "Invalid Request: jsonrpc must be 2.0");
    }

    let result = match request.method.as_str() {
        "initialize" => Ok(json!({
            "name": "coding-agent-toolchain",
            "version": env!("CARGO_PKG_VERSION"),
            "protocol": "mcp-style-jsonrpc-stdio"
        })),
        "tools/list" => Ok(list_tools()),
        "tools/call" => call_tool(request.params),
        _ => Err(anyhow::anyhow!("Method not found")),
    };

    match result {
        Ok(result) => RpcResponse {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        },
        Err(err) => err_response(id, -32000, &err.to_string()),
    }
}

fn err_response(id: Option<Value>, code: i64, message: &str) -> RpcResponse {
    RpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcError {
            code,
            message: message.to_string(),
        }),
    }
}

fn list_tools() -> Value {
    json!({
      "tools": [
        {"name":"read_file","description":"Read UTF-8 text from a local file.","input_schema":{"type":"object","required":["path"],"properties":{"path":{"type":"string"}}}},
        {"name":"create_new_file","description":"Create a new file and fail if it already exists.","input_schema":{"type":"object","required":["path","contents"],"properties":{"path":{"type":"string"},"contents":{"type":"string"}}}},
        {"name":"write_file","description":"Write UTF-8 text to a local file (create or overwrite).","input_schema":{"type":"object","required":["path","contents"],"properties":{"path":{"type":"string"},"contents":{"type":"string"}}}},
        {"name":"read_currently_open_file","description":"Read the file path currently selected by client context (pass path).","input_schema":{"type":"object","required":["path"],"properties":{"path":{"type":"string"}}}},
        {"name":"ls","description":"List direct entries in a directory.","input_schema":{"type":"object","required":["path"],"properties":{"path":{"type":"string"}}}},
        {"name":"list_dir","description":"List files recursively under a directory.","input_schema":{"type":"object","required":["path"],"properties":{"path":{"type":"string"},"max_entries":{"type":"integer","default":500}}}},
        {"name":"file_glob_search","description":"Find files matching a glob pattern.","input_schema":{"type":"object","required":["pattern"],"properties":{"pattern":{"type":"string"},"max_results":{"type":"integer","default":200}}}},
        {"name":"flie_glob_search","description":"Backward-compatible typo alias for file_glob_search.","input_schema":{"type":"object","required":["pattern"],"properties":{"pattern":{"type":"string"},"max_results":{"type":"integer","default":200}}}},
        {"name":"search_text","description":"Search for literal text in files.","input_schema":{"type":"object","required":["path","pattern"],"properties":{"path":{"type":"string"},"pattern":{"type":"string"},"max_results":{"type":"integer","default":200}}}},
        {"name":"grep_search","description":"Search regex pattern in files using grep.","input_schema":{"type":"object","required":["path","pattern"],"properties":{"path":{"type":"string"},"pattern":{"type":"string"}}}},
        {"name":"run_command","description":"Run a local command inside the repo.","input_schema":{"type":"object","required":["cmd"],"properties":{"cmd":{"type":"string"},"cwd":{"type":"string"}}}},
        {"name":"run_terminal_command","description":"Alias for run_command.","input_schema":{"type":"object","required":["cmd"],"properties":{"cmd":{"type":"string"},"cwd":{"type":"string"}}}},
        {"name":"view_diff","description":"Alias for git_diff.","input_schema":{"type":"object","properties":{"cwd":{"type":"string"}}}},
        {"name":"git_status","description":"Get git status output.","input_schema":{"type":"object","properties":{"cwd":{"type":"string"}}}},
        {"name":"git_diff","description":"Get git diff output.","input_schema":{"type":"object","properties":{"cwd":{"type":"string"}}}},
        {"name":"create_rule_block","description":"Create a markdown rule block and optionally append to a file.","input_schema":{"type":"object","required":["title","body"],"properties":{"title":{"type":"string"},"body":{"type":"string"},"append_to":{"type":"string"}}}},
        {"name":"request_rule","description":"Find a rule text by key in a file.","input_schema":{"type":"object","required":["path","key"],"properties":{"path":{"type":"string"},"key":{"type":"string"}}}},
        {"name":"read_skill","description":"Read a skill markdown or instruction file.","input_schema":{"type":"object","required":["path"],"properties":{"path":{"type":"string"}}}},
        {"name":"multi_edit","description":"Apply multiple string replacements to a file.","input_schema":{"type":"object","required":["path","edits"],"properties":{"path":{"type":"string"},"edits":{"type":"array"}}}},
        {"name":"fetch_url_content","description":"Fetch URL contents using curl.","input_schema":{"type":"object","required":["url"],"properties":{"url":{"type":"string"}}}},
        {"name":"cat","description":"Alias for read_file.","input_schema":{"type":"object","required":["path"],"properties":{"path":{"type":"string"}}}},
        {"name":"sed","description":"Run sed expression on file and return output (no in-place write).","input_schema":{"type":"object","required":["path","expression"],"properties":{"path":{"type":"string"},"expression":{"type":"string"}}}},
        {"name":"grep","description":"Run grep command and return matches.","input_schema":{"type":"object","required":["path","pattern"],"properties":{"path":{"type":"string"},"pattern":{"type":"string"}}}},
        {"name":"delete_file","description":"Delete a local file.","input_schema":{"type":"object","required":["path"],"properties":{"path":{"type":"string"}}}},
        {"name":"rename_file","description":"Rename a local file or directory.","input_schema":{"type":"object","required":["source","destination"],"properties":{"source":{"type":"string"},"destination":{"type":"string"}}}},
        {"name":"mkdir","description":"Create a directory.","input_schema":{"type":"object","required":["path"],"properties":{"path":{"type":"string"}}}},
        {"name":"apply_patch","description":"Apply a unified diff patch to the repository using git apply.","input_schema":{"type":"object","required":["patch"],"properties":{"patch":{"type":"string"},"cwd":{"type":"string"}}}}
      ]
    })
}

fn call_tool(params: Value) -> Result<Value> {
    let call: ToolCallParams =
        serde_json::from_value(params).context("Invalid tool call params")?;

    match call.name.as_str() {
        "read_file" | "cat" | "read_currently_open_file" | "read_skill" => {
            read_file(call.arguments)
        }
        "write_file" => write_file(call.arguments),
        "create_new_file" => create_new_file(call.arguments),
        "ls" => ls(call.arguments),
        "list_dir" => list_dir(call.arguments),
        "file_glob_search" | "flie_glob_search" => file_glob_search(call.arguments),
        "search_text" => search_text(call.arguments),
        "grep_search" | "grep" => grep_search(call.arguments),
        "run_command" | "run_terminal_command" => run_command(call.arguments),
        "git_status" => git_status(call.arguments),
        "git_diff" | "view_diff" => git_diff(call.arguments),
        "create_rule_block" => create_rule_block(call.arguments),
        "request_rule" => request_rule(call.arguments),
        "multi_edit" => multi_edit(call.arguments),
        "fetch_url_content" => fetch_url_content(call.arguments),
        "sed" => sed_tool(call.arguments),
        "delete_file" => delete_file(call.arguments),
        "rename_file" => rename_file(call.arguments),
        "mkdir" => mkdir(call.arguments),
        "apply_patch" => apply_patch(call.arguments),
        _ => Err(anyhow::anyhow!("Unknown tool: {}", call.name)),
    }
}

fn read_file(args: Value) -> Result<Value> {
    let path = required_string(&args, "path")?;
    let contents = fs::read_to_string(&path).with_context(|| format!("failed to read {path}"))?;
    Ok(json!({ "path": path, "contents": contents }))
}

fn create_new_file(args: Value) -> Result<Value> {
    let path = required_string(&args, "path")?;
    let contents = required_string(&args, "contents")?;
    if Path::new(&path).exists() {
        return Err(anyhow::anyhow!("file already exists: {path}"));
    }
    fs::write(&path, contents).with_context(|| format!("failed to write {path}"))?;
    Ok(json!({ "path": path, "created": true }))
}

fn write_file(args: Value) -> Result<Value> {
    let path = required_string(&args, "path")?;
    let contents = required_string(&args, "contents")?;
    fs::write(&path, contents).with_context(|| format!("failed to write {path}"))?;
    Ok(json!({ "path": path, "written": true }))
}

fn delete_file(args: Value) -> Result<Value> {
    let path = required_string(&args, "path")?;
    fs::remove_file(&path).with_context(|| format!("failed to delete {path}"))?;
    Ok(json!({ "path": path, "deleted": true }))
}

fn rename_file(args: Value) -> Result<Value> {
    let source = required_string(&args, "source")?;
    let destination = required_string(&args, "destination")?;
    fs::rename(&source, &destination).with_context(|| format!("failed to rename {source} to {destination}"))?;
    Ok(json!({ "source": source, "destination": destination, "renamed": true }))
}

fn mkdir(args: Value) -> Result<Value> {
    let path = required_string(&args, "path")?;
    fs::create_dir_all(&path).with_context(|| format!("failed to create directory {path}"))?;
    Ok(json!({ "path": path, "created": true }))
}

fn ls(args: Value) -> Result<Value> {
    let path = required_string(&args, "path")?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).with_context(|| format!("failed to list {path}"))? {
        let entry = entry?;
        entries.push(entry.path().display().to_string());
    }
    Ok(json!({"path": path, "entries": entries}))
}

fn list_dir(args: Value) -> Result<Value> {
    let path = required_string(&args, "path")?;
    let max_entries = optional_u64(&args, "max_entries").unwrap_or(500) as usize;

    let mut entries = Vec::new();
    for entry in WalkDir::new(&path).into_iter().filter_map(Result::ok) {
        if entries.len() >= max_entries {
            break;
        }
        if entry.path() == Path::new(&path) {
            continue;
        }
        entries.push(entry.path().display().to_string());
    }

    Ok(json!({ "path": path, "entries": entries, "truncated": entries.len() == max_entries }))
}

fn file_glob_search(args: Value) -> Result<Value> {
    let pattern = required_string(&args, "pattern")?;
    let max_results = optional_u64(&args, "max_results").unwrap_or(200) as usize;
    let mut matches = Vec::new();
    for path in (glob(&pattern).with_context(|| format!("invalid glob: {pattern}"))?).flatten() {
        matches.push(path.display().to_string());
        if matches.len() >= max_results {
            break;
        }
    }
    Ok(json!({"pattern": pattern, "matches": matches, "truncated": matches.len() == max_results}))
}

fn search_text(args: Value) -> Result<Value> {
    let root = required_string(&args, "path")?;
    let pattern = required_string(&args, "pattern")?;
    let max_results = optional_u64(&args, "max_results").unwrap_or(200) as usize;

    let mut matches = Vec::new();
    'files: for entry in WalkDir::new(&root).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        if let Ok(contents) = fs::read_to_string(path) {
            for (idx, line) in contents.lines().enumerate() {
                if line.contains(&pattern) {
                    matches.push(json!({
                        "path": path.display().to_string(),
                        "line": idx + 1,
                        "text": line
                    }));
                    if matches.len() >= max_results {
                        break 'files;
                    }
                }
            }
        }
    }

    Ok(
        json!({"path": root, "pattern": pattern, "matches": matches, "truncated": matches.len() == max_results}),
    )
}

fn grep_search(args: Value) -> Result<Value> {
    let path = required_string(&args, "path")?;
    let pattern = required_string(&args, "pattern")?;
    let output = Command::new("grep")
        .arg("-RIn")
        .arg(&pattern)
        .arg(&path)
        .output()
        .with_context(|| "failed to run grep")?;
    Ok(json!({
        "path": path,
        "pattern": pattern,
        "status": output.status.code(),
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr)
    }))
}

fn run_command(args: Value) -> Result<Value> {
    let cmd = required_string(&args, "cmd")?;
    let cwd = optional_string(&args, "cwd").unwrap_or_else(|| ".".to_string());

    let output = Command::new("bash")
        .arg("-lc")
        .arg(&cmd)
        .current_dir(PathBuf::from(cwd))
        .output()
        .with_context(|| format!("failed to run command: {cmd}"))?;

    Ok(json!({
        "cmd": cmd,
        "status": output.status.code(),
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr)
    }))
}

fn git_status(args: Value) -> Result<Value> {
    git_with_args(args, &["status", "--short", "--branch"])
}

fn git_diff(args: Value) -> Result<Value> {
    git_with_args(args, &["diff"])
}

fn create_rule_block(args: Value) -> Result<Value> {
    let title = required_string(&args, "title")?;
    let body = required_string(&args, "body")?;
    let block = format!("### Rule: {title}\n\n{body}\n");

    if let Some(path) = optional_string(&args, "append_to") {
        let mut existing = fs::read_to_string(&path).unwrap_or_default();
        if !existing.ends_with('\n') {
            existing.push('\n');
        }
        existing.push_str(&block);
        fs::write(&path, existing).with_context(|| format!("failed to append to {path}"))?;
        return Ok(json!({"title": title, "append_to": path, "written": true, "block": block}));
    }

    Ok(json!({"title": title, "block": block}))
}

fn request_rule(args: Value) -> Result<Value> {
    let path = required_string(&args, "path")?;
    let key = required_string(&args, "key")?;
    let contents = fs::read_to_string(&path).with_context(|| format!("failed to read {path}"))?;
    let lines: Vec<_> = contents
        .lines()
        .enumerate()
        .filter(|(_, line)| line.contains(&key))
        .map(|(line_no, line)| json!({"line": line_no + 1, "text": line}))
        .collect();
    Ok(json!({"path": path, "key": key, "matches": lines}))
}

fn multi_edit(args: Value) -> Result<Value> {
    let path = required_string(&args, "path")?;
    let edits: Vec<MultiEdit> = serde_json::from_value(
        args.get("edits")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("missing edits"))?,
    )
    .context("invalid edits payload")?;

    let mut contents =
        fs::read_to_string(&path).with_context(|| format!("failed to read {path}"))?;
    let mut applied = Vec::new();

    for edit in edits {
        let before = contents.clone();
        contents = contents.replace(&edit.old, &edit.new);
        if before != contents {
            applied.push(json!({"old": edit.old, "new": edit.new, "changed": true}));
        } else {
            applied.push(json!({"old": edit.old, "new": edit.new, "changed": false}));
        }
    }

    fs::write(&path, contents).with_context(|| format!("failed to write {path}"))?;
    Ok(json!({"path": path, "applied": applied}))
}

fn fetch_url_content(args: Value) -> Result<Value> {
    let url = required_string(&args, "url")?;
    let output = Command::new("curl")
        .arg("-fsSL")
        .arg(&url)
        .output()
        .with_context(|| format!("failed to run curl for {url}"))?;
    Ok(json!({
        "url": url,
        "status": output.status.code(),
        "content": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr)
    }))
}

fn sed_tool(args: Value) -> Result<Value> {
    let path = required_string(&args, "path")?;
    let expression = required_string(&args, "expression")?;
    let output = Command::new("sed")
        .arg(&expression)
        .arg(&path)
        .output()
        .with_context(|| "failed to run sed")?;
    Ok(json!({
        "path": path,
        "expression": expression,
        "status": output.status.code(),
        "stdout": String::from_utf8_lossy(&output.stdout),
        "stderr": String::from_utf8_lossy(&output.stderr)
    }))
}

fn git_with_args(args: Value, git_args: &[&str]) -> Result<Value> {
    let cwd = optional_string(&args, "cwd").unwrap_or_else(|| ".".to_string());
    let output = Command::new("git")
        .args(git_args)
        .current_dir(PathBuf::from(&cwd))
        .output()
        .with_context(|| format!("failed to run git {:?}", git_args))?;

    Ok(json!({
      "cwd": cwd,
      "status": output.status.code(),
      "stdout": String::from_utf8_lossy(&output.stdout),
      "stderr": String::from_utf8_lossy(&output.stderr)
    }))
}

fn apply_patch(args: Value) -> Result<Value> {
    let patch = required_string(&args, "patch")?;
    let cwd = optional_string(&args, "cwd").unwrap_or_else(|| ".".to_string());
    
    // Create a temporary patch file
    let tmp_path = std::env::temp_dir().join(format!("patch_{}.diff", std::process::id()));
    fs::write(&tmp_path, patch.clone()).with_context(|| "failed to write temporary patch file")?;
    
    let output = Command::new("git")
        .arg("apply")
        .arg("--unidiff-zero")
        .arg(&tmp_path)
        .current_dir(PathBuf::from(&cwd))
        .output()
        .with_context(|| "failed to run git apply")?;
        
    // Clean up
    let _ = fs::remove_file(tmp_path);

    Ok(json!({
      "cwd": cwd,
      "status": output.status.code(),
      "stdout": String::from_utf8_lossy(&output.stdout),
      "stderr": String::from_utf8_lossy(&output.stderr)
    }))
}

fn required_string(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| anyhow::anyhow!("missing string argument: {key}"))
}

fn optional_string(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn optional_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

#[allow(dead_code)]
fn _debug_dump_map(map: &BTreeMap<String, String>) -> Value {
    serde_json::to_value(map).unwrap_or_else(|_| json!({}))
}
