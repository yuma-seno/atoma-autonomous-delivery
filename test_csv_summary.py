#!/usr/bin/env python3
"""Comprehensive tests for csv_summary.py using unittest."""

import csv
import os
import sys
import tempfile
import unittest
from pathlib import Path

from csv_summary import scan_csv_files, main


class TestCsvSummary(unittest.TestCase):
    """Test suite for csv_summary module."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    # ------------------------------------------------------------------ #
    #  Helper
    # ------------------------------------------------------------------ #
    def _write_csv(self, path: Path, rows: list[list[str]]) -> None:
        """Write *rows* (including header) to *path*."""
        with path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerows(rows)

    # ------------------------------------------------------------------ #
    #  Tests
    # ------------------------------------------------------------------ #

    def test_basic_csv(self):
        """Create a CSV with 3 data rows + header → verify rows=3, columns=N, size>0."""
        header = ["a", "b", "c"]
        data = [
            ["1", "2", "3"],
            ["4", "5", "6"],
            ["7", "8", "9"],
        ]
        csv_path = self.temp_path / "test.csv"
        self._write_csv(csv_path, [header] + data)

        results = scan_csv_files(str(self.temp_path))
        self.assertEqual(len(results), 1)
        r = results[0]
        self.assertEqual(r["rows"], 3)
        self.assertEqual(r["columns"], 3)
        self.assertGreater(r["size"], 0)
        self.assertEqual(r["size"], os.path.getsize(csv_path))

    def test_multiple_files(self):
        """Create 2 CSV files → verify summary shows 2 files and total rows."""
        self._write_csv(self.temp_path / "a.csv", [["x"], ["1"], ["2"]])
        self._write_csv(self.temp_path / "b.csv", [["y"], ["10"], ["20"], ["30"]])

        results = scan_csv_files(str(self.temp_path))
        self.assertEqual(len(results), 2)

        total_rows = sum(r["rows"] for r in results)
        self.assertEqual(total_rows, 5)  # 2 + 3

    def test_empty_directory(self):
        """Run on an empty temp dir → verify 0 files."""
        results = scan_csv_files(str(self.temp_path))
        self.assertEqual(len(results), 0)

    def test_subdirectories(self):
        """Create CSV in a subdirectory → verify recursive scan finds it."""
        sub = self.temp_path / "sub"
        sub.mkdir()
        self._write_csv(sub / "nested.csv", [["h"], ["d1"], ["d2"]])

        results = scan_csv_files(str(self.temp_path))
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["rows"], 2)

    def test_varying_columns(self):
        """Create CSVs with different column counts → verify avg columns."""
        # 2 columns, 1 data row
        self._write_csv(self.temp_path / "n2.csv", [["a", "b"], ["1", "2"]])
        # 3 columns, 1 data row
        self._write_csv(self.temp_path / "n3.csv", [["x", "y", "z"], ["9", "8", "7"]])

        results = scan_csv_files(str(self.temp_path))
        self.assertEqual(len(results), 2)

        avg_cols = sum(r["columns"] for r in results) / len(results)
        self.assertEqual(avg_cols, 2.5)  # (2 + 3) / 2

    def test_header_excluded(self):
        """Verify header is NOT counted in row count (5 data rows + header → rows=5)."""
        header = ["col"]
        data_rows = [[str(i)] for i in range(5)]
        self._write_csv(self.temp_path / "hdr.csv", [header] + data_rows)

        results = scan_csv_files(str(self.temp_path))
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["rows"], 5)

    def test_main_function(self):
        """Run main() as script entry point → verify it runs without error."""
        test_file = self.temp_path / "data.csv"
        self._write_csv(test_file, [["h"], ["r1"], ["r2"]])

        # Capture stdout
        from io import StringIO
        from unittest.mock import patch

        with patch("sys.argv", ["csv_summary.py", str(self.temp_path)]), \
             patch("sys.stdout", new_callable=StringIO) as mock_stdout:
            main()
            output = mock_stdout.getvalue()

        self.assertIn("Summary:", output)
        self.assertIn("1 files", output)
        self.assertIn("2 total rows", output)


if __name__ == "__main__":
    unittest.main()