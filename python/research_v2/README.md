# Lightld Research V2 Sidecar

This optional offline sidecar exports canonical research V2 JSONL evidence to
date-partitioned Parquet and an immutable DuckDB snapshot. It is not imported by
the live runtime and never changes live configuration or creates proposals.

Install the optional dependencies:

```powershell
py -m pip install -r python/requirements-research-v2.txt
```

Export a snapshot:

```powershell
py python/research_v2/export_snapshot.py `
  --input state/research-v2/opportunity-episodes.jsonl `
  --output-root research-v2 `
  --dataset-id new-token-v1-2026-07-01 `
  --table opportunity_episodes `
  --timestamp-field capturedAt
```

The output layout is:

```text
research-v2/
  raw/date=YYYY-MM-DD/table=<table>/datasetId=<dataset>/part-00000.parquet
  curated/datasetId=<dataset>/snapshot.duckdb
  curated/datasetId=<dataset>/manifest.json
```

The manifest contains sorted artifact entries, source checksums, a normalized
record checksum, and a checksum of the manifest payload. Reusing a dataset ID is
idempotent only for identical source content and export settings; conflicting
content is rejected.

Run tests from the repository root:

```powershell
py -m unittest discover -s python/tests -v
```

When the optional dependencies are absent, integration tests are skipped with
the exact install command while canonical checksum tests still run.
