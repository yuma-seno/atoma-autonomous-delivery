"""Tests for todo_filter module."""

import copy
import unittest

from todo_filter import filter_by_status, filter_by_priority, filter_by_priority_range


SAMPLE_TASKS = [
    {"id": 1, "title": "Task A", "priority": 1, "done": True},
    {"id": 2, "title": "Task B", "priority": 2, "done": False},
    {"id": 3, "title": "Task C", "priority": 2, "done": True},
    {"id": 4, "title": "Task D", "priority": 3, "done": False},
]


class TestFilterByStatus(unittest.TestCase):
    def test_filter_done_returns_completed_tasks(self):
        result = filter_by_status(SAMPLE_TASKS, done=True)
        self.assertEqual(len(result), 2)
        for task in result:
            self.assertTrue(task["done"])
        self.assertEqual(result[0]["id"], 1)
        self.assertEqual(result[1]["id"], 3)

    def test_filter_not_done_returns_incomplete_tasks(self):
        result = filter_by_status(SAMPLE_TASKS, done=False)
        self.assertEqual(len(result), 2)
        for task in result:
            self.assertFalse(task["done"])
        self.assertEqual(result[0]["id"], 2)
        self.assertEqual(result[1]["id"], 4)

    def test_all_done(self):
        tasks = [{"id": 1, "title": "X", "priority": 1, "done": True}]
        result = filter_by_status(tasks, done=True)
        self.assertEqual(result, tasks)

    def test_none_done(self):
        tasks = [{"id": 1, "title": "X", "priority": 1, "done": False}]
        result = filter_by_status(tasks, done=True)
        self.assertEqual(result, [])

    def test_empty_list_returns_empty_list(self):
        self.assertEqual(filter_by_status([], done=True), [])
        self.assertEqual(filter_by_status([], done=False), [])

    def test_does_not_mutate_input(self):
        original = copy.deepcopy(SAMPLE_TASKS)
        filter_by_status(SAMPLE_TASKS, done=True)
        self.assertEqual(SAMPLE_TASKS, original)


class TestFilterByPriority(unittest.TestCase):
    def test_filter_by_priority_returns_matching_tasks(self):
        result = filter_by_priority(SAMPLE_TASKS, 2)
        self.assertEqual(len(result), 2)
        for task in result:
            self.assertEqual(task["priority"], 2)
        self.assertEqual(result[0]["id"], 2)
        self.assertEqual(result[1]["id"], 3)

    def test_filter_by_priority_no_match(self):
        result = filter_by_priority(SAMPLE_TASKS, 99)
        self.assertEqual(result, [])

    def test_filter_by_priority_single_match(self):
        result = filter_by_priority(SAMPLE_TASKS, 1)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], 1)

    def test_empty_list_returns_empty_list(self):
        self.assertEqual(filter_by_priority([], 1), [])

    def test_does_not_mutate_input(self):
        original = copy.deepcopy(SAMPLE_TASKS)
        filter_by_priority(SAMPLE_TASKS, 2)
        self.assertEqual(SAMPLE_TASKS, original)


class TestFilterByPriorityRange(unittest.TestCase):
    def test_filter_by_range_inclusive(self):
        result = filter_by_priority_range(SAMPLE_TASKS, 1, 2)
        self.assertEqual(len(result), 3)
        for task in result:
            self.assertIn(task["priority"], [1, 2])

    def test_filter_by_range_single_value(self):
        result = filter_by_priority_range(SAMPLE_TASKS, 2, 2)
        self.assertEqual(len(result), 2)
        for task in result:
            self.assertEqual(task["priority"], 2)

    def test_filter_by_range_all(self):
        result = filter_by_priority_range(SAMPLE_TASKS, 1, 3)
        self.assertEqual(len(result), 4)

    def test_filter_by_range_no_match(self):
        result = filter_by_priority_range(SAMPLE_TASKS, 10, 20)
        self.assertEqual(result, [])

    def test_min_greater_than_max_returns_empty(self):
        result = filter_by_priority_range(SAMPLE_TASKS, 5, 1)
        self.assertEqual(result, [])

    def test_empty_list_returns_empty_list(self):
        self.assertEqual(filter_by_priority_range([], 1, 3), [])

    def test_does_not_mutate_input(self):
        original = copy.deepcopy(SAMPLE_TASKS)
        filter_by_priority_range(SAMPLE_TASKS, 1, 2)
        self.assertEqual(SAMPLE_TASKS, original)


if __name__ == "__main__":
    unittest.main()