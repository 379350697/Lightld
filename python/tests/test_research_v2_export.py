from __future__ import annotations

import json
import shutil
import sys
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


PYTHON_ROOT = Path(__file__).resolve().parents[1]
TEST_TEMP_ROOT = PYTHON_ROOT.parent / "tmp" / "python-research-v2-tests"
TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from research_v2.export_snapshot import (  # noqa: E402
    OPTIONAL_DEPENDENCY_MESSAGE,
    canonical_json_bytes,
    export_dataset,
    optional_dependencies_available,
    sha256_bytes,
)


class CanonicalManifestUtilitiesTest(unittest.TestCase):
    def test_canonical_json_and_checksum_are_order_independent(self) -> None:
        left = {"b": 2, "a": {"z": True, "x": None}}
        right = {"a": {"x": None, "z": True}, "b": 2}

        self.assertEqual(canonical_json_bytes(left), canonical_json_bytes(right))
        self.assertEqual(sha256_bytes(canonical_json_bytes(left)), sha256_bytes(canonical_json_bytes(right)))

    def test_export_rejects_v1_and_unsafe_dataset_ids_before_loading_optional_engines(self) -> None:
        with local_temporary_directory("lightld-research-v2-contract-") as temporary:
            root = Path(temporary)
            source = root / "legacy.jsonl"
            source.write_text(
                '{"schemaVersion":1,"capturedAt":"2026-07-01T00:00:00.000Z"}\n',
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "rejects non-V2"):
                export_dataset(
                    input_paths=[source],
                    output_root=root / "out",
                    dataset_id="dataset-test",
                    table_name="opportunity_episodes",
                    timestamp_field="capturedAt",
                )
            with self.assertRaisesRegex(ValueError, "safe letters"):
                export_dataset(
                    input_paths=[source],
                    output_root=root / "out",
                    dataset_id="../escape",
                    table_name="opportunity_episodes",
                    timestamp_field="capturedAt",
                )


@unittest.skipUnless(optional_dependencies_available(), OPTIONAL_DEPENDENCY_MESSAGE)
class ResearchV2ExportIntegrationTest(unittest.TestCase):
    def test_exports_partitioned_parquet_and_an_immutable_duckdb_snapshot(self) -> None:
        with local_temporary_directory("lightld-research-v2-") as temporary:
            root = Path(temporary)
            source = root / "episodes.jsonl"
            output_root = root / "research-v2"
            rows = [
                {
                    "schemaVersion": 2,
                    "episodeId": "episode-2",
                    "capturedAt": "2026-07-02T00:00:00.000Z",
                    "value": 2,
                },
                {
                    "value": 1,
                    "capturedAt": "2026-07-01T00:00:00.000Z",
                    "episodeId": "episode-1",
                    "schemaVersion": 2,
                },
            ]
            source.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")

            manifest = export_dataset(
                input_paths=[source],
                output_root=output_root,
                dataset_id="dataset-test",
                table_name="opportunity_episodes",
                timestamp_field="capturedAt",
            )
            repeated = export_dataset(
                input_paths=[source],
                output_root=output_root,
                dataset_id="dataset-test",
                table_name="opportunity_episodes",
                timestamp_field="capturedAt",
            )

            self.assertEqual(manifest, repeated)
            self.assertEqual(manifest["schemaVersion"], 2)
            self.assertEqual(manifest["rowCount"], 2)
            self.assertEqual(
                [partition["date"] for partition in manifest["partitions"]],
                ["2026-07-01", "2026-07-02"],
            )
            relative_paths = [entry["relativePath"] for entry in manifest["artifacts"]]
            self.assertEqual(relative_paths, sorted(relative_paths))
            for relative_path in relative_paths:
                self.assertTrue((output_root / relative_path).is_file())

            manifest_path = output_root / "curated" / "datasetId=dataset-test" / "manifest.json"
            self.assertEqual(
                json.loads(manifest_path.read_text(encoding="utf-8")),
                manifest,
            )

            import duckdb

            connection = duckdb.connect(
                str(output_root / "curated" / "datasetId=dataset-test" / "snapshot.duckdb"),
                read_only=True,
            )
            try:
                exported = connection.execute(
                    'SELECT episodeId FROM "opportunity_episodes" ORDER BY episodeId'
                ).fetchall()
            finally:
                connection.close()
            self.assertEqual(exported, [("episode-1",), ("episode-2",)])

    def test_refuses_to_reuse_a_dataset_id_for_different_source_content(self) -> None:
        with local_temporary_directory("lightld-research-v2-conflict-") as temporary:
            root = Path(temporary)
            source = root / "episodes.jsonl"
            output_root = root / "research-v2"
            source.write_text(
                '{"schemaVersion":2,"episodeId":"episode-1","capturedAt":"2026-07-01T00:00:00.000Z"}\n',
                encoding="utf-8",
            )
            export_dataset(
                input_paths=[source],
                output_root=output_root,
                dataset_id="dataset-test",
                table_name="opportunity_episodes",
                timestamp_field="capturedAt",
            )
            source.write_text(
                '{"schemaVersion":2,"episodeId":"episode-2","capturedAt":"2026-07-01T00:00:00.000Z"}\n',
                encoding="utf-8",
            )

            with self.assertRaisesRegex(ValueError, "immutable dataset conflict"):
                export_dataset(
                    input_paths=[source],
                    output_root=output_root,
                    dataset_id="dataset-test",
                    table_name="opportunity_episodes",
                    timestamp_field="capturedAt",
                )


@contextmanager
def local_temporary_directory(prefix: str) -> Iterator[str]:
    path = TEST_TEMP_ROOT / f"{prefix}{uuid.uuid4().hex}"
    path.mkdir(parents=True, exist_ok=False)
    try:
        yield str(path)
    finally:
        shutil.rmtree(path, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
