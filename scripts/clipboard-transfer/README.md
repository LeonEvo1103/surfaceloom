# Reliable clipboard file transfer

This product-neutral helper transfers a small binary artifact to an interactive Windows PowerShell prompt when keyboard forwarding or ordinary file sharing is unavailable. It was designed for clipboard transports that may silently truncate or alter a long paste.

The sender creates a bounded PowerShell bootstrap followed by plain ASCII data frames consumed by a `Read-Host` receiver loop. The receiver persists all state on disk, so a new PowerShell process can resume the same session. Transfer is bytes-only: this helper never extracts, executes, or interprets the resulting artifact.

## Prepare an outbox

Node.js 20 or newer is required on the source machine.

```bash
node scripts/clipboard-transfer/prepare.mjs \
  --input ./artifact.zip \
  --target-name artifact.zip \
  --output-dir ./clipboard-outbox
```

Optional arguments are `--session-id` (exactly 32 lowercase hex characters), `--chunk-bytes`, and `--max-command-chars`. The default raw chunk is 1200 bytes, producing 1600 Base64 characters; every bootstrap command and data frame has a hard 1800-character limit. Payload chunks shrink automatically to fit; preparation fails if any fixed frame cannot fit. A 129256-byte payload uses 108 data frames plus fewer than 60 one-time bootstrap frames. The 64 MiB total-size cap and 100,000-chunk cap are deliberate because the sender materializes an outbox in memory.

Preparation publishes `READY` last inside a staged directory and refuses an existing outbox. `plan.json` contains lengths, hashes, and relative frame names, but no Base64 payload. Chunk command files necessarily contain the payload and should be protected like the input artifact.

## Paste on Windows

Open a dedicated classic Windows PowerShell 5.1 or PowerShell 7 prompt, change to a short directory that should receive the final file, and do not change directory until cleanup finishes. The working root is limited to 120 UTF-16 characters and the projected final path to 240 characters so Windows PowerShell 5.1 never reaches legacy deep-path failures in internal state or temporary files. A longer location fails before creating state with `CT_ERROR CT_PATH_TOO_LONG`; use a short root such as `C:\slm` instead.

Paste frames in this order:

1. Every PowerShell file under `commands/init`, in numeric order. After each paste, wait for its exact `expectedMarker` from `plan.json` **and for the PowerShell prompt to return**.
2. Paste `commands/receiveLoop.ps1.txt` and wait for a fresh `CT_LOOP_READY`.
3. Paste files under `commands/chunks` in any order. They are plain `SLMCT1|...` data, not PowerShell. After every paste, wait for its `CT_CHUNK_OK` marker and the next fresh `CT_LOOP_READY`. Repeating the complete set is safe.
4. Paste `commands/loopStatus.frame.txt`; require `MISSING=none` and the next `CT_LOOP_READY`.
5. Paste `commands/loopFinalize.frame.txt`; require `CT_FINALIZE_OK` and the next `CT_LOOP_READY`.
6. After independently checking the final artifact, paste `commands/loopCleanup.frame.txt`. Cleanup exits the loop.

Each frame contains no CR, LF, NUL, or trailing newline, so one paste plus Enter is one operation. Never send the next frame merely after a fixed delay: consume the current frame's completion marker and wait for the prompt or fresh `CT_LOOP_READY`. Initialization installs a SHA-pinned, product-neutral receiver under `.slm-clipboard-transfer`. Chunk payloads enter through `Read-Host`, so they are not parsed as PowerShell and do not enter PSReadLine command history.

If initialization is interrupted before the receiver exists, wait for the prompt and paste `commands/abortInit.ps1.txt`. It independently checks the exact allowed inventory and every reparse boundary before deleting only that unfinished session. When `manifest.json` already exists it additionally requires its exact hash; when interruption happened immediately after prepare, the manifest may be absent and the empty/bootstrap-only session is still removable. It never reads or deletes the target. A conflict fails closed instead of using recursive cleanup.

Success markers begin with `CT_INIT_`, `CT_LOOP_READY`, `CT_CHUNK_OK`, `CT_STATUS`, `CT_FINALIZE_OK`, or `CT_CLEANUP_OK`. A failure prints only `CT_ERROR <code>` and sets `$global:LASTEXITCODE` to `1`; it does not print payload or absolute paths. A corrupt data frame leaves the loop alive and emits another `CT_LOOP_READY`, allowing exact replay. These commands are intended for an interactive prompt. `$global:LASTEXITCODE` is not a promise about the process exit code if the embedded receiver is separately invoked with `powershell -File`.

Bootstrap inventory failures are deliberately segmented without exposing paths or item names: `CT_INIT_INV_MANIFEST_HASH`, `CT_INIT_INV_ENUM`, `CT_INIT_INV_PART_COUNT`, and `CT_INIT_INV_ITEM` distinguish the fixed validation stage that failed. The expected part count is compiled directly into the frame instead of relying on target-side JSON number semantics. Inventory logic is GZip-wrapped so Base64, decompression, or embedded-script corruption reports `CT_INIT_INV_FRAME_INVALID`. Replay only after resolving the reported stage; use `abortInit.ps1.txt` to remove an unfinished, exact-schema session.

`CT_STATUS` reports compact missing index ranges such as `0,2-4,9`. Output is capped after 256 ranges to prevent a pathological alternating-missing set from flooding the console.

## Protocol guarantees

- The source target is one NFC-normalized Windows leaf name. Absolute paths, traversal, separators, ADS, wildcards, trailing dot/space, reserved device names, and framework state names are rejected.
- The current directory and every existing ancestor, state directory, session directory, chunk, partial file, and target are checked for reparse points before use.
- Initialization rejects an overlong working root or projected target path before creating the state directory. The installed receiver rechecks the root before touching transfer state and rechecks the projected length before resolving or using the target.
- A canonical JSON session manifest binds session ID, target name, total length, final SHA-256, raw chunk size, and exact chunk count. Reusing a session ID with different manifest bytes is rejected.
- Every chunk command binds index, expected raw length, canonical Base64, and SHA-256. Same-index/same-bytes replay is idempotent; a conflicting replay is rejected. Chunks are written to a same-session temporary file and atomically published.
- Status and finalize work after a PowerShell restart; paste `receiveLoop.ps1.txt` again to resume. Finalize requires the exact chunk filename set, validates each chunk again, writes a partial file in the target directory, closes and reopens it, checks final length and SHA-256, then performs a non-overwriting atomic rename.
- An existing regular target succeeds only when both length and SHA-256 match. A different target is never overwritten.
- The receiver engine is shared by content hash across sessions. Inflation first creates session-local `engine.raw.work`; when the shared engine already exists, that verified work file may remain until cleanup. Replayed assembly can likewise leave `engine.gz.work`.
- Per-session named mutexes serialize chunk, status, finalize, and cleanup operations. Cleanup hash-gates the manifest and deletes only the exact session schema, including those exact replay-safe engine work names; directories, reparse points, case variants, and unexpected names still fail closed. It never deletes the final target.

SHA-256 here detects clipboard and storage corruption. It does not authenticate who produced the outbox. Obtain the source artifact and outbox through a trusted channel, and perform any signature verification in a separate deployment step.

## Validation

Run the platform-neutral protocol, simulator, static PowerShell, and CLI tests on macOS or Linux:

```bash
node --test scripts/clipboard-transfer/tests/*.test.mjs
```

When `pwsh` is available (or `SURFACELOOM_POWERSHELL_EXE` names an executable), the suite also generates a complete 129256-byte outbox and requires PowerShell's AST parser to report zero errors for every generated `.ps1.txt` file and both receiver source scripts. This parser gate is mandatory in the Windows CI job with Windows PowerShell 5.1. It can also be run against an existing outbox directly:

```powershell
powershell.exe -NoProfile -File scripts\clipboard-transfer\test-outbox-powershell-syntax.ps1 -Outbox clipboard-outbox -IncludeSources
```

The reference receiver tests cover zero/boundary/binary payloads, out-of-order and duplicate chunks, restart recovery, missing ranges, corrupt/conflicting chunks, manifest conflicts, final hash failure, existing targets, exact cleanup, traversal, and symlink/reparse analogues.

Static tests cannot prove Windows PowerShell parameter binding or filesystem behavior. On Windows, prepare an outbox and run the real receiver end to end in both Windows PowerShell 5.1 and PowerShell 7:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\clipboard-transfer\test-windows-e2e.ps1 -Outbox clipboard-outbox
pwsh.exe -NoProfile -File scripts\clipboard-transfer\test-windows-e2e.ps1 -Outbox clipboard-outbox
```

For a new remote-control product, first perform a manual transport probe at conservative sizes and set `--max-command-chars` to the largest repeatedly verified value with margin. Do not infer a universal clipboard limit from one machine. The default 1800-character ceiling reflects the currently verified remote path after 2600-character pastes were observed to corrupt silently.
