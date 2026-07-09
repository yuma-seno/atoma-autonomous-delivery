"""Tests for memo_search module."""

import pytest
from memo_search import search_memos


SAMPLE_MEMOS = [
    {"id": 1, "text": "Hello World", "created_at": "2025-01-01T00:00:00"},
    {"id": 2, "text": "hello world again", "created_at": "2025-01-02T00:00:00"},
    {"id": 3, "text": "Python programming", "created_at": "2025-01-03T00:00:00"},
    {"id": 4, "text": "HELLO EVERYONE", "created_at": "2025-01-04T00:00:00"},
    {"id": 5, "text": "Goodbye World", "created_at": "2025-01-05T00:00:00"},
]


class TestSearchMemos:
    def test_empty_keyword_returns_all(self):
        result = search_memos(SAMPLE_MEMOS, "")
        assert result == SAMPLE_MEMOS

    def test_case_insensitive_search(self):
        result = search_memos(SAMPLE_MEMOS, "hello")
        assert len(result) == 3
        ids = {m["id"] for m in result}
        assert ids == {1, 2, 4}

    def test_search_partial_word(self):
        result = search_memos(SAMPLE_MEMOS, "world")
        assert len(result) == 3
        ids = {m["id"] for m in result}
        assert ids == {1, 2, 5}

    def test_search_no_match(self):
        result = search_memos(SAMPLE_MEMOS, "zzzzz")
        assert result == []

    def test_search_middle_of_text(self):
        result = search_memos(SAMPLE_MEMOS, "gramming")
        assert len(result) == 1
        assert result[0]["id"] == 3

    def test_empty_memo_list(self):
        result = search_memos([], "hello")
        assert result == []

    def test_keyword_is_substring_case_insensitive(self):
        result = search_memos(SAMPLE_MEMOS, "PYTHON")
        assert len(result) == 1
        assert result[0]["id"] == 3

    def test_search_with_special_characters(self):
        memos = [
            {"id": 1, "text": "test (parentheses) here", "created_at": "2025-01-01T00:00:00"},
            {"id": 2, "text": "no match", "created_at": "2025-01-02T00:00:00"},
        ]
        result = search_memos(memos, "parentheses")
        assert len(result) == 1
        assert result[0]["id"] == 1