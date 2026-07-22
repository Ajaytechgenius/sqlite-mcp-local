# sqlite-mcp-local

A lightweight, **read-only** MCP server for a local SQLite database. It communicates only via standard input/output, so it is intended to be launched by Claude Desktop, Claude Code, or another MCP client — not as an HTTP service.

## Requirements

- Node.js **22.13+** (uses Node's built-in `node:sqlite`)
- A local SQLite database

Runtime dependency: only [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk). No SQLite native addon or database service is required.

## Install and run

```bash
npm install
npm run build
node dist/index.js /absolute/path/to/my-data.db
```

Or set `SQLITE_MCP_DB`:

```bash
SQLITE_MCP_DB=./my-data.sqlite node dist/index.js
```

For zero-config use, start it in a directory containing exactly one `.db`, `.sqlite`, or `.sqlite3` file:

```bash
node dist/index.js
```

The database path is fixed when the server starts. The tools never accept file paths.

## Claude Desktop configuration

Add this to the `mcpServers` section of your Claude Desktop configuration (adjust paths):

```json
{
  "mcpServers": {
    "local-sqlite": {
      "command": "node",
      "args": ["/absolute/path/to/sqlite-mcp-local/dist/index.js", "/absolute/path/to/my-data.db"]
    }
  }
}
```

After saving, restart Claude Desktop. Build the project once before launching it from Claude.

## Tools

| Tool | Input | What it does |
|---|---|---|
| `list_tables` | none | Lists user tables and views. |
| `get_schema` | `table_name` | Returns CREATE SQL, columns, indexes (including index columns), and foreign keys. |
| `execute_read_query` | `query` | Runs one `SELECT`, `WITH`, or `EXPLAIN` query; results are capped at 1,000 rows. |

## Safety model

- The database opens using SQLite's read-only mode.
- SQL execution is restricted to one statement beginning with `SELECT`, `WITH`, or `EXPLAIN`. The parser correctly allows semicolons inside quoted strings and comments.
- SQLite itself opens the file in read-only mode, providing the final enforcement layer even for complex CTEs.
- Query results are streamed and stop after 1,000 rows rather than materializing an unbounded result set.
- Large SQLite integers serialize safely as strings; BLOBs serialize as `{ "type": "blob", "base64": "..." }`.
- The server writes diagnostic logs to **stderr** only; stdout remains exclusively for the MCP stdio protocol.

This is intentionally a simple local tool, not an authentication or multi-user database gateway.
