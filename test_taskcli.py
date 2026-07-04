"""Tests for TaskStore."""

import os
import json
import tempfile
import unittest

from taskcli import TaskStore


class TestTaskStore(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.path = os.path.join(self.tmpdir, ".taskcli.json")
        self.store = TaskStore(self.path)

    def tearDown(self):
        if os.path.exists(self.path):
            os.remove(self.path)
        os.rmdir(self.tmpdir)

    # --- load ---

    def test_load_returns_empty_list_when_file_missing(self):
        self.assertEqual(self.store.load(), [])

    def test_load_returns_tasks(self):
        data = [{"id": 1, "description": "test", "created_at": "2025-01-01T00:00:00", "done": False}]
        with open(self.path, "w") as f:
            json.dump(data, f)
        self.assertEqual(self.store.load(), data)

    def test_load_raises_on_corrupt_json(self):
        with open(self.path, "w") as f:
            f.write("{invalid")
        with self.assertRaises(ValueError):
            self.store.load()

    def test_load_raises_on_non_list(self):
        with open(self.path, "w") as f:
            json.dump({"not": "a list"}, f)
        with self.assertRaises(ValueError):
            self.store.load()

    # --- save ---

    def test_save_writes_valid_json(self):
        tasks = [{"id": 1, "description": "hello", "created_at": "2025-01-01T00:00:00", "done": False}]
        self.store.save(tasks)
        with open(self.path) as f:
            loaded = json.load(f)
        self.assertEqual(loaded, tasks)

    # --- add ---

    def test_add_first_task_gets_id_1(self):
        task = self.store.add("first task")
        self.assertEqual(task["id"], 1)
        self.assertEqual(task["description"], "first task")
        self.assertFalse(task["done"])
        self.assertIn("created_at", task)

    def test_add_increments_id(self):
        t1 = self.store.add("task a")
        t2 = self.store.add("task b")
        self.assertEqual(t1["id"], 1)
        self.assertEqual(t2["id"], 2)

    # --- get_by_id ---

    def test_get_by_id_returns_task(self):
        self.store.add("find me")
        task = self.store.get_by_id(1)
        self.assertIsNotNone(task)
        self.assertEqual(task["description"], "find me")

    def test_get_by_id_returns_none_when_not_found(self):
        self.assertIsNone(self.store.get_by_id(999))

    # --- list_tasks ---

    def test_list_tasks_returns_all_with_include_done(self):
        self.store.add("task1")
        self.store.add("task2")
        self.store.mark_done(1)
        all_tasks = self.store.list_tasks(include_done=True)
        self.assertEqual(len(all_tasks), 2)

    def test_list_tasks_excludes_done_by_default(self):
        self.store.add("task1")
        self.store.add("task2")
        self.store.mark_done(1)
        active = self.store.list_tasks()
        self.assertEqual(len(active), 1)
        self.assertEqual(active[0]["id"], 2)

    # --- mark_done ---

    def test_mark_done_updates_task(self):
        self.store.add("do something")
        updated = self.store.mark_done(1)
        self.assertIsNotNone(updated)
        self.assertTrue(updated["done"])
        # verify persistence
        loaded = self.store.load()
        self.assertTrue(loaded[0]["done"])

    def test_mark_done_returns_none_when_not_found(self):
        self.assertIsNone(self.store.mark_done(999))

    # --- delete ---

    def test_delete_removes_task(self):
        self.store.add("delete me")
        result = self.store.delete(1)
        self.assertTrue(result)
        self.assertEqual(len(self.store.load()), 0)

    def test_delete_returns_false_when_not_found(self):
        self.assertFalse(self.store.delete(999))


if __name__ == "__main__":
    unittest.main()
