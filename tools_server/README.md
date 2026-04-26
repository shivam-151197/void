# And-Gate-Implementation-Neural-Network

## Rust MCP-style coding toolchain server

This repository includes a Rust-based local toolchain server for coding agents.

- Entry point: `src/main.rs`
- Protocol: JSON-RPC 2.0 over stdio (MCP-style)
- Full docs: `docs/mcp_toolchain.md`

### Quick start

```bash
cargo run
```

### Included tools

`read_file`, `create_new_file`, `run_terminal_command`, `flie_glob_search`, `view_diff`, `read_currently_open_file`, `ls`, `create_rule_block`, `fetch_url_content`, `request_rule`, `read_skill`, `multi_edit`, `grep_search`, plus `sed`, `grep`, `cat`, and additional aliases.

Send `initialize`, `tools/list`, and `tools/call` messages via stdin/stdout from your MCP/LLM client adapter.
