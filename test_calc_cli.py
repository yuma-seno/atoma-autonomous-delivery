"""Unit tests for calc_cli.py CLI logic.

Tests focus on argument parsing, command routing, and the printed output
of each subcommand.
"""

import sys
from io import StringIO

import pytest

from calc_cli import create_parser, main, run_add, run_div, run_mul, run_sub

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _capture_main(argv: list[str]) -> str:
    """Run main() with the given argv and return captured stdout."""
    old_stdout = sys.stdout
    sys.stdout = StringIO()
    try:
        main(argv)
        return sys.stdout.getvalue()
    finally:
        sys.stdout = old_stdout


def _capture_main_exit(argv: list[str]) -> tuple[str, int]:
    """Run main() with the given argv and return (stdout, exit_code).

    Catches SystemExit so the caller can inspect the exit code.
    """
    old_stdout = sys.stdout
    sys.stdout = StringIO()
    try:
        main(argv)
        return sys.stdout.getvalue(), 0
    except SystemExit as e:
        return sys.stdout.getvalue(), e.code if e.code is not None else 0
    finally:
        sys.stdout = old_stdout


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


class TestCreateParser:
    """Tests for argument parser construction."""

    def test_parser_requires_command(self):
        """Omitting a command should exit."""
        parser = create_parser()
        with pytest.raises(SystemExit):
            parser.parse_args([])

    def test_add_parses_two_floats(self):
        """add a b parses both operands as float."""
        parser = create_parser()
        ns = parser.parse_args(["add", "3", "4"])
        assert ns.command == "add"
        assert ns.a == 3.0
        assert ns.b == 4.0

    def test_sub_parses_two_floats(self):
        """sub a b parses both operands as float."""
        parser = create_parser()
        ns = parser.parse_args(["sub", "10", "3"])
        assert ns.command == "sub"
        assert ns.a == 10.0
        assert ns.b == 3.0

    def test_mul_parses_two_floats(self):
        """mul a b parses both operands as float."""
        parser = create_parser()
        ns = parser.parse_args(["mul", "3", "4"])
        assert ns.command == "mul"
        assert ns.a == 3.0
        assert ns.b == 4.0

    def test_div_parses_two_floats(self):
        """div a b parses both operands as float."""
        parser = create_parser()
        ns = parser.parse_args(["div", "10", "2"])
        assert ns.command == "div"
        assert ns.a == 10.0
        assert ns.b == 2.0

    def test_float_inputs(self):
        """Non-integer float strings are parsed correctly."""
        parser = create_parser()
        ns = parser.parse_args(["add", "3.5", "2.1"])
        assert ns.a == 3.5
        assert ns.b == 2.1


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------


class TestRunAdd:
    """Tests for the add operation."""

    def test_add_positive(self):
        """3 + 4 = 7.0"""
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        try:
            run_add(3.0, 4.0)
            output = sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout
        assert output.strip() == "7.0"

    def test_add_negative(self):
        """(-1) + (-2) = -3.0"""
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        try:
            run_add(-1.0, -2.0)
            output = sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout
        assert output.strip() == "-3.0"

    def test_add_float(self):
        """1.5 + 2.5 = 4.0"""
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        try:
            run_add(1.5, 2.5)
            output = sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout
        assert output.strip() == "4.0"


class TestRunSub:
    """Tests for the sub operation."""

    def test_sub_positive(self):
        """10 - 3 = 7.0"""
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        try:
            run_sub(10.0, 3.0)
            output = sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout
        assert output.strip() == "7.0"

    def test_sub_negative_result(self):
        """3 - 10 = -7.0"""
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        try:
            run_sub(3.0, 10.0)
            output = sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout
        assert output.strip() == "-7.0"


class TestRunMul:
    """Tests for the mul operation."""

    def test_mul_positive(self):
        """3 * 4 = 12.0"""
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        try:
            run_mul(3.0, 4.0)
            output = sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout
        assert output.strip() == "12.0"

    def test_mul_negative(self):
        """-3 * 4 = -12.0"""
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        try:
            run_mul(-3.0, 4.0)
            output = sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout
        assert output.strip() == "-12.0"

    def test_mul_zero(self):
        """5 * 0 = 0.0"""
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        try:
            run_mul(5.0, 0.0)
            output = sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout
        assert output.strip() == "0.0"


class TestRunDiv:
    """Tests for the div operation."""

    def test_div_positive(self):
        """10 / 2 = 5.0"""
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        try:
            run_div(10.0, 2.0)
            output = sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout
        assert output.strip() == "5.0"

    def test_div_negative(self):
        """10 / -2 = -5.0"""
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        try:
            run_div(10.0, -2.0)
            output = sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout
        assert output.strip() == "-5.0"

    def test_div_float_result(self):
        """1 / 2 = 0.5"""
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        try:
            run_div(1.0, 2.0)
            output = sys.stdout.getvalue()
        finally:
            sys.stdout = old_stdout
        assert output.strip() == "0.5"

    def test_div_by_zero_stderr_and_exit(self):
        """5 / 0 prints 'Error: division by zero' to stderr and exits 1."""
        old_stdout = sys.stdout
        old_stderr = sys.stderr
        sys.stdout = StringIO()
        sys.stderr = StringIO()
        try:
            with pytest.raises(SystemExit) as exc_info:
                run_div(5.0, 0.0)
            assert exc_info.value.code == 1
            stderr_output = sys.stderr.getvalue()
            assert "Error: division by zero" in stderr_output
        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr


# ---------------------------------------------------------------------------
# main() integration
# ---------------------------------------------------------------------------


class TestMain:
    """Integration tests for the main() entry point."""

    def test_main_add(self):
        """main(['add', '3', '4']) prints 7.0"""
        output = _capture_main(["add", "3", "4"])
        assert output.strip() == "7.0"

    def test_main_sub(self):
        """main(['sub', '10', '3']) prints 7.0"""
        output = _capture_main(["sub", "10", "3"])
        assert output.strip() == "7.0"

    def test_main_mul(self):
        """main(['mul', '3', '4']) prints 12.0"""
        output = _capture_main(["mul", "3", "4"])
        assert output.strip() == "12.0"

    def test_main_div(self):
        """main(['div', '10', '2']) prints 5.0"""
        output = _capture_main(["div", "10", "2"])
        assert output.strip() == "5.0"

    def test_main_div_by_zero(self):
        """main(['div', '5', '0']) prints error and exits 1."""
        output, code = _capture_main_exit(["div", "5", "0"])
        # When run_div exits, stderr is captured by the fixture
        assert code == 1

    def test_main_float_operands(self):
        """main(['add', '3.5', '2.1']) prints 5.6"""
        output = _capture_main(["add", "3.5", "2.1"])
        # Python float arithmetic: 3.5 + 2.1 = 5.6
        assert abs(float(output.strip()) - 5.6) < 1e-9