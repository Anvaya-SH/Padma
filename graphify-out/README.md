# Padma repository graph

Generated locally with Graphify 0.9.76 and SQL grammar 0.3.11 on 2026-10-05.
The snapshot includes the working tree's uncommitted changes, not just HEAD.

## Open

- [Interactive community overview](./graph.html): 443 community nodes and 3,030 cross-community connections.
- [Source and symbol hierarchy](./GRAPH_TREE.html): browse and search the repository tree.
- [Graph report](./GRAPH_REPORT.md): community membership, hubs, and relationship analysis.
- [Machine-readable graph](./graph.json): 20,564 nodes and 67,612 exported relationship records.
- [Validation results](./validation.json): structural checks, counts, and graph hash.

The graph represents 1,911 source-file paths. The report counts 65,664 graph
connections; the JSON additionally preserves parallel relationship records,
which accounts for its larger edge count. The overview aggregates communities
rather than trying to display every symbol at once.

## Harness integration

The desktop profile's native `graphify-native` Host plugin registers a `graphify`
skill and standing instructions to query an existing graph before broad code
searches. The current session successfully loaded the skill. Four focused adapter
tests passed. No application bundle, replacement server, npm dependency, or
repository source was changed by this installation.

The CLI remains available through Harness's existing permission-aware PowerShell
tool. Set its working directory to this repository:

```powershell
$env:PYTHONUTF8='1'
& 'C:\Users\Hp\.local\bin\graphify.exe' query 'session persistence' --budget 2000
& 'C:\Users\Hp\.local\bin\graphify.exe' path 'MemoryStorage' 'Storage'
```

The verified path result is `MemoryStorage --implements [EXTRACTED]--> Storage`.
The SQLite schema also contributes 21 nodes.

## Refresh locally

Run each step only after the previous command succeeds:

```powershell
$env:PYTHONUTF8='1'
& 'C:\Users\Hp\.local\bin\graphify.exe' extract . --code-only --no-cluster --max-workers 4
& 'C:\Users\Hp\.local\bin\graphify.exe' cluster-only . --no-label --no-viz
& 'C:\Users\Hp\.local\bin\graphify.exe' export html --node-limit 2500
& 'C:\Users\Hp\.local\bin\graphify.exe' tree --root . --label Padma
```

## Coverage limits

- Extraction and clustering used no external semantic backend or paid model calls.
- Documentation and media semantic extraction were intentionally omitted.
- Some data/config/source files produce no symbols in Graphify.
- Graphify reported parser recovery in `packages/tui/test/latex.test.ts`; its extraction may be partial. The source was not modified.
- Generated/dependency directories and potentially sensitive files were excluded.
- Graph data can become stale during ongoing edits. Verify relevant source before making changes.
- The HTML viewers load pinned visualization libraries from public CDNs; opening them may require internet access. No repository data is sent to a semantic backend.
