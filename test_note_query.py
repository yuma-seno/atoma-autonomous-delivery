"""Tests for note_query module."""

import pytest
from note_query import all_tags, find_by_keyword, find_by_tag


SAMPLE_NOTES = [
    {"id": 1, "text": "Buy groceries", "tags": ["personal", "shopping"]},
    {"id": 2, "text": "Meeting notes about Python", "tags": ["work", "python"]},
    {"id": 3, "text": "Python project ideas", "tags": ["personal", "python"]},
    {"id": 4, "text": "Shopping list for camping", "tags": ["shopping"]},
    {"id": 5, "text": "Workout plan", "tags": ["personal"]},
]


class TestFindByTag:
    def test_matching_tag(self):
        result = find_by_tag(SAMPLE_NOTES, "python")
        assert len(result) == 2
        ids = {n["id"] for n in result}
        assert ids == {2, 3}

    def test_matching_tag_single_result(self):
        result = find_by_tag(SAMPLE_NOTES, "work")
        assert len(result) == 1
        assert result[0]["id"] == 2

    def test_no_match(self):
        result = find_by_tag(SAMPLE_NOTES, "urgent")
        assert result == []

    def test_non_destructive(self):
        original_ids = [n["id"] for n in SAMPLE_NOTES]
        find_by_tag(SAMPLE_NOTES, "python")
        assert [n["id"] for n in SAMPLE_NOTES] == original_ids

    def test_empty_note_list(self):
        result = find_by_tag([], "python")
        assert result == []

    def test_note_without_tags_key(self):
        notes = [{"id": 1, "text": "no tags"}]
        result = find_by_tag(notes, "anything")
        assert result == []


class TestFindByKeyword:
    def test_case_insensitive_search(self):
        result = find_by_keyword(SAMPLE_NOTES, "python")
        assert len(result) == 2
        ids = {n["id"] for n in result}
        assert ids == {2, 3}

    def test_uppercase_keyword(self):
        result = find_by_keyword(SAMPLE_NOTES, "PYTHON")
        assert len(result) == 2
        ids = {n["id"] for n in result}
        assert ids == {2, 3}

    def test_mixed_case_keyword(self):
        result = find_by_keyword(SAMPLE_NOTES, "GrOcErIeS")
        assert len(result) == 1
        assert result[0]["id"] == 1

    def test_partial_word_match(self):
        result = find_by_keyword(SAMPLE_NOTES, "shop")
        assert len(result) == 1
        assert result[0]["id"] == 4

    def test_no_match(self):
        result = find_by_keyword(SAMPLE_NOTES, "zzzzz")
        assert result == []

    def test_non_destructive(self):
        original_ids = [n["id"] for n in SAMPLE_NOTES]
        find_by_keyword(SAMPLE_NOTES, "python")
        assert [n["id"] for n in SAMPLE_NOTES] == original_ids

    def test_empty_note_list(self):
        result = find_by_keyword([], "python")
        assert result == []

    def test_note_without_text_key(self):
        notes = [{"id": 1}]
        result = find_by_keyword(notes, "anything")
        assert result == []


class TestAllTags:
    def test_unique_tags_sorted(self):
        result = all_tags(SAMPLE_NOTES)
        assert result == ["personal", "python", "shopping", "work"]

    def test_empty_note_list(self):
        result = all_tags([])
        assert result == []

    def test_notes_with_no_tags(self):
        notes = [{"id": 1, "text": "no tags"}]
        result = all_tags(notes)
        assert result == []

    def test_tags_are_deduplicated(self):
        notes = [
            {"id": 1, "text": "a", "tags": ["a", "b", "a"]},
            {"id": 2, "text": "b", "tags": ["b", "c"]},
        ]
        result = all_tags(notes)
        assert result == ["a", "b", "c"]

    def test_single_tag(self):
        notes = [{"id": 1, "text": "a", "tags": ["only"]}]
        result = all_tags(notes)
        assert result == ["only"]