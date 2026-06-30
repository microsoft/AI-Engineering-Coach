# Design Specification: Antigravity Log Analysis Support

This document outlines the technical design for adding log analysis support for **Antigravity** (Google DeepMind's agentic AI coding assistant) into the **AI Engineer Coach** VS Code extension.

## 1. Goal

Enable local offline analysis of Antigravity conversations by parsing their SQLite-backed trajectory databases (`.db` files) stored on the user's filesystem, mapping them to the standard `Session` and `SessionRequest` representations, and surfacing them in the extension's dashboard UI under the unified harness name `"Antigravity"`.

## 2. Directory Discovery

Antigravity stores its conversations under the user's home directory. The extension will automatically discover conversation logs from the following three locations:
*   `~/.gemini/antigravity/conversations` (Antigravity Main)
*   `~/.gemini/antigravity-cli/conversations` (Antigravity CLI)
*   `~/.gemini/antigravity-ide/conversations` (Antigravity IDE)

Files with the `.db` extension in these directories will be parsed. Files with the `.pb` extension are encrypted at the OS level and will be skipped.

## 3. Database Schema & Querying

Each `.db` file represents a single agent session (trajectory). The parser will use the system's `sqlite3` command-line tool to query:

1.  **Metadata Query**:
    ```sql
    SELECT data FROM trajectory_metadata_blob WHERE id = 'main'
    ```
    This binary Protobuf blob contains workspace root path, repository name, branch, and session-level details.

2.  **Steps Query**:
    ```sql
    SELECT idx, step_type, hex(step_payload) FROM steps ORDER BY idx
    ```
    This returns the trajectory steps. Returning `hex(step_payload)` ensures the binary Protobuf data is safely serialized to a hex string across the process stdout boundary.

## 4. Protobuf Decoding

A lightweight, zero-dependency Protobuf decoder will be implemented in TypeScript. It parses the binary buffer recursively using standard varint and length-delimited wire types, automatically decoding printable UTF-8 strings.

Key field mappings for step payloads (`step_payload`):
*   **Step Type 14 (User Prompt)**:
    *   Prompt Text: field `19` -> `2` (string)
    *   Timestamp: field `5` -> `1` -> `1` (varint, Unix seconds)
*   **Step Type 15 / 101 (Assistant Response)**:
    *   Response Text: field `20` -> `1` (or `20` -> `8` as fallback)
    *   If `101` (Message): field `114` -> `1` (contains formatted message string) or `114` -> `4` -> `4`
    *   Timestamp: field `5` -> `1` -> `1` (varint, Unix seconds)
    *   Token usage (in field `5` -> `9`):
        *   Prompt tokens: field `1` (varint)
        *   Output tokens: field `2` (varint)
        *   Thinking/reasoning tokens: field `3` (varint)
*   **Step Type 21 (Tool Call)**:
    *   Tool Name: field `5` -> `4` -> `9` or `5` -> `4` -> `2`
    *   Tool Arguments (JSON string): field `5` -> `4` -> `3`. We will parse this JSON to extract `editedFiles` (e.g. from `write_file`) and `referencedFiles` (e.g. from `view_file`).
*   **Step Type 17 (Error/Status)**:
    *   Error message / JSON details: field `24` -> `3` -> `5` or `24` -> `3` -> `1`. We will parse this to check for model IDs (e.g., `gemini-3.5-flash-low`).

## 5. UI Integration

*   **Harness Color**: A distinct orange/amber color (`#d97706`) will be registered for `"Antigravity"` in `src/webview/shared.ts` (`HARNESS_COLORS`) and `src/webview/page-config.ts` (`HC`).
*   **Model Breakdown**: If model IDs are detected (e.g. `gemini-3.5-flash`), they will be populated on `SessionRequest` objects, enabling correct model distribution breakdown on the dashboard.

## 6. Verification Plan

### Automated Tests
We will add `src/core/parser-antigravity.test.ts` to cover:
*   Directory discovery logic.
*   Protobuf decoder decoding of varints and length-delimited fields.
*   Turn assembly and session mapping from sample SQLite records.
*   Integration checking inside `parser-harnesses.ts`.

### Manual Verification
*   Build the extension using `npm run build`.
*   Run `npm test` to verify unit tests.
*   Open the Dashboard inside VS Code to verify that local Antigravity sessions are correctly loaded, colored, and aggregated.
