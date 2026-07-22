# sqlite-mcp-local

A lightweight Model Context Protocol (MCP) server that enables AI assistants like Claude Desktop and Claude Code to inspect, query, and analyze local SQLite databases.

## Features
- **List Tables:** Inspect schema and structure of local SQLite database files.
- **Execute Read Queries:** Safe, read-only SQL queries directly from your AI agent.
- **Zero Configuration:** Designed to work instantly via standard I/O (stdio).

## Installation & Usage

Run via npx:
```bash
npx sqlite-mcp-local /path/to/your/database.db
