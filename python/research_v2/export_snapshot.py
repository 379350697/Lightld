from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import shutil
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


OPTIONAL_DEPENDENCY_MESSAGE = (
    "optional research dependencies are missing; install them with "
    "`py -m pip install -r python/requirements-research-v2.txt`"
)
_TABLE_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_DATASET_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def optional_dependencies_available() -> bool:
    return all(importlib.util.find_spec(module) is not None for module in ("duckdb", "pyarrow"))


def require_optional_dependencies() -> None:
    if not optional_dependencies_available():
        raise RuntimeError(OPTIONAL_DEPENDENCY_MESSAGE)


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def export_dataset(
    *,
    input_paths: Sequence[Path | str],
    output_root: Path | str,
    dataset_id: str,
    table_name: str,
    timestamp_field: str,
) -> dict[str, Any]:
    """Export immutable JSONL evidence to date-partitioned Parquet and DuckDB.

    Records are canonicalized and ordered by a content checksum before export.
    Reusing a dataset id is idempotent only when the normalized record checksum
    and export contract are identical.
    """

    if not _DATASET_ID_PATTERN.fullmatch(dataset_id):
        raise ValueError("dataset_id must contain only safe letters, numbers, dot, underscore, or hyphen")
    if not _TABLE_NAME_PATTERN.fullmatch(table_name):
        raise ValueError("table_name must be a safe SQL identifier")
    if not timestamp_field.strip():
        raise ValueError("timestamp_field must not be empty")
    if not input_paths:
        raise ValueError("at least one JSONL input path is required")

    output = Path(output_root)
    sources, records = _load_sources(input_paths, timestamp_field)
    normalized_records = _normalize_records(records)
    normalized_checksum = sha256_bytes(
        b"\n".join(canonical_json_bytes(record) for record in normalized_records) + b"\n"
    )
    curated_root = output / "curated" / f"datasetId={dataset_id}"
    manifest_path = curated_root / "manifest.json"

    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (
            existing.get("datasetId") == dataset_id
            and existing.get("tableName") == table_name
            and existing.get("timestampField") == timestamp_field
            and existing.get("normalizedRecordsSha256") == normalized_checksum
            and existing.get("sources") == sources
        ):
            _verify_existing_artifacts(output, existing)
            return existing
        raise ValueError(f"immutable dataset conflict for dataset id {dataset_id}")

    require_optional_dependencies()
    _remove_partial_dataset(output, curated_root, dataset_id, table_name)
    curated_root.mkdir(parents=True, exist_ok=True)

    partition_entries, parquet_paths = _write_partitions(
        output=output,
        dataset_id=dataset_id,
        table_name=table_name,
        timestamp_field=timestamp_field,
        records=normalized_records,
    )
    snapshot_path = curated_root / "snapshot.duckdb"
    _write_duckdb_snapshot(
        snapshot_path=snapshot_path,
        parquet_paths=parquet_paths,
        table_name=table_name,
        dataset_id=dataset_id,
        normalized_checksum=normalized_checksum,
    )

    artifacts = [
        _artifact_entry(output, path)
        for path in [*parquet_paths, snapshot_path]
    ]
    artifacts.sort(key=lambda entry: entry["relativePath"])
    manifest_without_checksum: dict[str, Any] = {
        "schemaVersion": 2,
        "datasetId": dataset_id,
        "tableName": table_name,
        "timestampField": timestamp_field,
        "rowCount": len(normalized_records),
        "normalizedRecordsSha256": normalized_checksum,
        "sources": sources,
        "partitions": partition_entries,
        "artifacts": artifacts,
    }
    manifest = {
        **manifest_without_checksum,
        "manifestSha256": sha256_bytes(canonical_json_bytes(manifest_without_checksum)),
    }
    manifest_path.write_bytes(canonical_json_bytes(manifest) + b"\n")
    return manifest


def _load_sources(
    input_paths: Sequence[Path | str],
    timestamp_field: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    source_entries: list[dict[str, Any]] = []
    records: list[dict[str, Any]] = []
    paths = sorted((Path(path) for path in input_paths), key=lambda path: path.as_posix())
    resolved_paths = [path.resolve() for path in paths]
    if len(set(resolved_paths)) != len(resolved_paths):
        raise ValueError("duplicate JSONL input path")

    for source_index, path in enumerate(paths):
        if not path.is_file():
            raise FileNotFoundError(path)
        row_count = 0
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, start=1):
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(f"invalid JSONL at {path}:{line_number}: {error.msg}") from error
                if not isinstance(value, dict):
                    raise ValueError(f"JSONL record at {path}:{line_number} must be an object")
                if value.get("schemaVersion") != 2:
                    raise ValueError(
                        f"research V2 export rejects non-V2 record at {path}:{line_number}"
                    )
                _extract_partition_date(value, timestamp_field, path, line_number)
                records.append(value)
                row_count += 1
        source_entries.append({
            "sourceIndex": source_index,
            "fileName": path.name,
            "sizeBytes": path.stat().st_size,
            "sha256": sha256_file(path),
            "rowCount": row_count,
        })

    return source_entries, records


def _normalize_records(records: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen_checksums: set[str] = set()
    for value in records:
        if "_record_sha256" in value:
            raise ValueError("input record uses reserved field _record_sha256")
        canonical_value = json.loads(canonical_json_bytes(value).decode("utf-8"))
        record_checksum = sha256_bytes(canonical_json_bytes(canonical_value))
        if record_checksum in seen_checksums:
            raise ValueError(f"duplicate canonical research record {record_checksum}")
        seen_checksums.add(record_checksum)
        normalized.append({**canonical_value, "_record_sha256": record_checksum})
    normalized.sort(key=lambda record: record["_record_sha256"])
    return normalized


def _write_partitions(
    *,
    output: Path,
    dataset_id: str,
    table_name: str,
    timestamp_field: str,
    records: Sequence[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[Path]]:
    import pyarrow as pa
    import pyarrow.parquet as parquet

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        grouped[_extract_partition_date(record, timestamp_field)].append(record)

    partitions: list[dict[str, Any]] = []
    parquet_paths: list[Path] = []
    for date in sorted(grouped):
        partition_records = sorted(grouped[date], key=lambda record: record["_record_sha256"])
        columns = sorted({key for record in partition_records for key in record})
        rectangular_records = [
            {column: record.get(column) for column in columns}
            for record in partition_records
        ]
        table = pa.Table.from_pylist(rectangular_records)
        partition_root = (
            output
            / "raw"
            / f"date={date}"
            / f"table={table_name}"
            / f"datasetId={dataset_id}"
        )
        partition_root.mkdir(parents=True, exist_ok=True)
        parquet_path = partition_root / "part-00000.parquet"
        parquet.write_table(
            table,
            parquet_path,
            compression="zstd",
            use_dictionary=False,
            write_statistics=True,
            version="2.6",
        )
        relative_path = parquet_path.relative_to(output).as_posix()
        partitions.append({
            "date": date,
            "rowCount": len(partition_records),
            "relativePath": relative_path,
            "sha256": sha256_file(parquet_path),
        })
        parquet_paths.append(parquet_path)

    if not parquet_paths:
        raise ValueError("cannot export an empty dataset")
    return partitions, parquet_paths


def _write_duckdb_snapshot(
    *,
    snapshot_path: Path,
    parquet_paths: Sequence[Path],
    table_name: str,
    dataset_id: str,
    normalized_checksum: str,
) -> None:
    import duckdb

    if snapshot_path.exists():
        snapshot_path.unlink()
    parquet_sql = ",".join(_sql_string(path.resolve().as_posix()) for path in parquet_paths)
    quoted_table = f'"{table_name}"'
    connection = duckdb.connect(str(snapshot_path))
    try:
        connection.execute(
            f"CREATE TABLE {quoted_table} AS "
            f"SELECT * FROM read_parquet([{parquet_sql}], union_by_name=true) "
            "ORDER BY _record_sha256"
        )
        connection.execute(
            "CREATE TABLE snapshot_metadata AS SELECT ? AS dataset_id, ? AS normalized_records_sha256",
            [dataset_id, normalized_checksum],
        )
        connection.execute("CHECKPOINT")
    finally:
        connection.close()


def _extract_partition_date(
    record: Mapping[str, Any],
    timestamp_field: str,
    source_path: Path | None = None,
    line_number: int | None = None,
) -> str:
    raw_timestamp = record.get(timestamp_field)
    location = ""
    if source_path is not None and line_number is not None:
        location = f" at {source_path}:{line_number}"
    if not isinstance(raw_timestamp, str):
        raise ValueError(f"missing string timestamp field {timestamp_field}{location}")
    try:
        parsed = datetime.fromisoformat(raw_timestamp.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"invalid timestamp field {timestamp_field}{location}") from error
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp field {timestamp_field} must include a UTC offset{location}")
    return parsed.astimezone(timezone.utc).date().isoformat()


def _artifact_entry(output: Path, path: Path) -> dict[str, Any]:
    return {
        "relativePath": path.relative_to(output).as_posix(),
        "sizeBytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def _verify_existing_artifacts(output: Path, manifest: Mapping[str, Any]) -> None:
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list):
        raise ValueError("existing dataset manifest has no artifact catalog")
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise ValueError("existing dataset manifest has an invalid artifact entry")
        relative_path = artifact.get("relativePath")
        expected_checksum = artifact.get("sha256")
        if not isinstance(relative_path, str) or not isinstance(expected_checksum, str):
            raise ValueError("existing dataset manifest has an invalid artifact entry")
        path = output / relative_path
        if not path.is_file() or sha256_file(path) != expected_checksum:
            raise ValueError(f"immutable dataset artifact is missing or corrupt: {relative_path}")


def _remove_partial_dataset(
    output: Path,
    curated_root: Path,
    dataset_id: str,
    table_name: str,
) -> None:
    if curated_root.exists():
        shutil.rmtree(curated_root)
    raw_root = output / "raw"
    if not raw_root.exists():
        return
    for target in raw_root.glob(f"date=*/table={table_name}/datasetId={dataset_id}"):
        if target.is_dir():
            shutil.rmtree(target)


def _sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Export Lightld research V2 JSONL to immutable Parquet and DuckDB snapshots."
    )
    parser.add_argument("--input", action="append", required=True, dest="input_paths", type=Path)
    parser.add_argument("--output-root", type=Path, default=Path("research-v2"))
    parser.add_argument("--dataset-id", required=True)
    parser.add_argument("--table", required=True, dest="table_name")
    parser.add_argument("--timestamp-field", default="capturedAt")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)
    try:
        manifest = export_dataset(
            input_paths=args.input_paths,
            output_root=args.output_root,
            dataset_id=args.dataset_id,
            table_name=args.table_name,
            timestamp_field=args.timestamp_field,
        )
    except RuntimeError as error:
        raise SystemExit(str(error)) from error
    print(json.dumps(manifest, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
