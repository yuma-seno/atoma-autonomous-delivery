#!/usr/bin/env python3
"""CLI tool to scan CSV files and aggregate row/column/file-size statistics."""

import csv
import os
import sys
from pathlib import Path


def scan_csv_files(directory: str = ".") -> list[dict]:
    """Scan directory recursively for CSV files and return stats for each.

    Returns a list of dicts with keys: file, rows, columns, size.
    """
    results: list[dict] = []
    base = Path(directory)
    for csv_path in sorted(base.rglob("*.csv")):
        try:
            with csv_path.open(newline="", encoding="utf-8", errors="replace") as f:
                reader = csv.reader(f)
                try:
                    header = next(reader)
                except StopIteration:
                    # Empty file — skip
                    continue
                columns = len(header)
                rows = sum(1 for _ in reader)
        except Exception:
            # Skip files that can't be read as CSV
            continue

        results.append(
            {
                "file": str(csv_path.relative_to(base)),
                "rows": rows,
                "columns": columns,
                "size": csv_path.stat().st_size,
            }
        )
    return results


def format_output(results: list[dict]) -> str:
    """Format results as a tab-separated table with a summary line."""
    lines: list[str] = []
    # Header
    lines.append("File\tRows\tColumns\tSize")
    for r in results:
        lines.append(f"{r['file']}\t{r['rows']}\t{r['columns']}\t{r['size']}")
    # Separator
    lines.append("---\t---\t---\t---")
    # Summary
    total_files = len(results)
    total_rows = sum(r["rows"] for r in results)
    avg_columns = (
        sum(r["columns"] for r in results) / total_files if total_files > 0 else 0.0
    )
    lines.append(
        f"Summary: {total_files} files, {total_rows} total rows, avg {avg_columns} columns"
    )
    return "\n".join(lines)


def main() -> None:
    directory = sys.argv[1] if len(sys.argv) > 1 else "."
    results = scan_csv_files(directory)
    print(format_output(results))


if __name__ == "__main__":
    main()