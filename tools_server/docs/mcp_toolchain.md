# Rust MCP-Style Toolchain for Coding Agents

Yes — this server is designed so your IDE can stay separate from the LLM interface while the LLM calls this local service.

## Architecture

- **IDE:** your editor/workbench only.
- **LLM Client:** chat/UI layer that decides which tool to call.
- **This Rust service:** JSON-RPC 2.0 stdio process that executes local codebase tools.

## Build and run

```bash
cargo build
cargo run
```

## RPC methods

- `initialize`
- `tools/list`
- `tools/call`

## Full tool catalog (requested + aliases)

### Core file tools
- `read_file`
- `create_new_file`
- `write_file`
- `read_currently_open_file` (client passes file path)
- `cat` (alias of `read_file`)

### Directory/search tools
- `ls`
- `list_dir`
- `file_glob_search`
- `flie_glob_search` (typo alias kept for compatibility)
- `search_text`
- `grep_search`
- `grep`
- `sed`

### Command/git tools
- `run_terminal_command`
- `run_command`
- `git_status`
- `git_diff`
- `view_diff` (alias of `git_diff`)

### Rule/skill and editing tools
- `create_rule_block`
- `request_rule`
- `read_skill`
- `multi_edit`
- `fetch_url_content`

## Tool call format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "run_terminal_command",
    "arguments": {
      "cmd": "git status --short",
      "cwd": "."
    }
  }
}
```

## Example calls

### List tools
```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
```

### Read file
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "read_file",
    "arguments": {"path": "README.md"}
  }
}
```

### Glob search
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "file_glob_search",
    "arguments": {"pattern": "src/**/*.rs", "max_results": 100}
  }
}
```

### Multi edit
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "multi_edit",
    "arguments": {
      "path": "README.md",
      "edits": [
        {"old": "foo", "new": "bar"},
        {"old": "hello", "new": "world"}
      ]
    }
  }
}
```

## Notes

- For `read_currently_open_file`, the server cannot infer editor state directly; pass the current file path from your client.
- `flie_glob_search` is intentionally included due to your requested tool naming.
- `sed`, `grep`, `run_command`, and `fetch_url_content` execute system commands; use client-side policy controls as needed.
