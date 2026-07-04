#!/usr/bin/env python3
"""Scan text files in the current directory and display file statistics."""

import os

SCAN_EXTENSIONS = {'.txt', '.md', '.py', '.yml', '.yaml', '.json', '.toml'}


def should_skip(entry: os.DirEntry) -> bool:
    """Return True if the entry should be skipped (hidden or __pycache__)."""
    name = entry.name
    if name.startswith('.'):
        return True
    if entry.is_dir(follow_symlinks=False) and name == '__pycache__':
        return True
    return False


def scan_directory(root: str) -> list[dict]:
    """Scan root directory recursively and return file stats."""
    results = []
    for entry in os.scandir(root):
        if should_skip(entry):
            continue
        if entry.is_dir(follow_symlinks=False):
            results.extend(scan_directory(entry.path))
        elif entry.is_file(follow_symlinks=False):
            ext = os.path.splitext(entry.name)[1].lower()
            if ext in SCAN_EXTENSIONS:
                stat = entry.stat()
                file_size = stat.st_size
                try:
                    with open(entry.path, 'r', encoding='utf-8', errors='replace') as f:
                        content = f.read()
                except Exception:
                    continue
                line_count = content.count('\n')
                if content and not content.endswith('\n'):
                    line_count += 1
                char_count = len(content)
                results.append({
                    'path': os.path.relpath(entry.path, root),
                    'lines': line_count,
                    'chars': char_count,
                    'size': file_size,
                })
    return results


def format_table(results: list[dict]) -> str:
    """Format results as an aligned table."""
    if not results:
        return 'No matching files found.'

    max_path_len = max(len(r['path']) for r in results)
    path_width = max(max_path_len, 20)

    header = f"{'File':<{path_width}} {'Lines':>6} {'Chars':>6} {'Size':>6}"
    sep = '-' * path_width + ' ' + '-' * 6 + ' ' + '-' * 6 + ' ' + '-' * 6
    lines = [header, sep]

    for r in results:
        lines.append(
            f"{r['path']:<{path_width}} {r['lines']:>6} {r['chars']:>6} {r['size']:>6}"
        )

    total_files = len(results)
    total_lines = sum(r['lines'] for r in results)
    total_chars = sum(r['chars'] for r in results)

    lines.append(sep)
    lines.append(
        f"{'Total:':<{path_width}} {total_files:>6} files, {total_lines:>6} lines, {total_chars:>6} characters"
    )

    return '\n'.join(lines)


def main() -> None:
    root = os.getcwd()
    results = scan_directory(root)
    output = format_table(results)
    print(output)


if __name__ == '__main__':
    main()