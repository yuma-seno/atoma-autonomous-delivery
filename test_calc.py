"""
test_calc.py - Unit tests for calc.py.

Run with: python test_calc.py
"""

from calc import evaluate


def test_addition():
    result = evaluate("1 + 2")
    assert result == 3, f"Expected 3, got {result}"


def test_subtraction():
    result = evaluate("5 - 3")
    assert result == 2, f"Expected 2, got {result}"


def test_multiplication():
    result = evaluate("4 * 3")
    assert result == 12, f"Expected 12, got {result}"


def test_division():
    result = evaluate("10 / 2")
    assert result == 5, f"Expected 5, got {result}"


def test_division_float():
    result = evaluate("7 / 2")
    assert result == 3.5, f"Expected 3.5, got {result}"


def test_division_by_zero():
    try:
        evaluate("1 / 0")
        assert False, "Expected ZeroDivisionError"
    except ZeroDivisionError:
        pass  # Expected


def test_floating_point():
    result = evaluate("2.5 + 3.5")
    assert result == 6, f"Expected 6, got {result}"


def test_floating_point_mixed():
    result = evaluate("1.5 * 2")
    assert result == 3, f"Expected 3, got {result}"


def test_floating_point_subtraction():
    result = evaluate("5.5 - 1.2")
    assert abs(result - 4.3) < 1e-10, f"Expected ~4.3, got {result}"


def test_operator_precedence():
    result = evaluate("1 + 2 * 3")
    assert result == 7, f"Expected 7, got {result}"


def test_operator_precedence2():
    result = evaluate("10 - 2 * 3")
    assert result == 4, f"Expected 4, got {result}"


def test_operator_precedence3():
    result = evaluate("10 / 2 + 3")
    assert result == 8, f"Expected 8, got {result}"


def test_parentheses():
    result = evaluate("(1 + 2) * 3")
    assert result == 9, f"Expected 9, got {result}"


def test_parentheses_nested():
    result = evaluate("((1 + 2) * (3 - 1))")
    assert result == 6, f"Expected 6, got {result}"


def test_parentheses_complex():
    result = evaluate("(1 + 2 * 3) - (4 / 2)")
    assert result == 5, f"Expected 5, got {result}"


def test_negative_start():
    result = evaluate("-5 + 3")
    assert result == -2, f"Expected -2, got {result}"


def test_large_expression():
    result = evaluate("2 + 3 * 4 - 6 / 2")
    assert result == 11, f"Expected 11, got {result}"


def test_whitespace_handling():
    result = evaluate("  1  +  2  ")
    assert result == 3, f"Expected 3, got {result}"


def test_empty_input():
    result = evaluate("")
    assert result is None, f"Expected None, got {result}"


def test_whitespace_only_input():
    result = evaluate("   ")
    assert result is None, f"Expected None, got {result}"


def test_subtraction_negative_result():
    result = evaluate("2 - 5")
    assert result == -3, f"Expected -3, got {result}"


def test_multiple_operations():
    result = evaluate("1 + 2 + 3 + 4")
    assert result == 10, f"Expected 10, got {result}"


def test_mixed_operators():
    result = evaluate("10 - 5 + 2")
    assert result == 7, f"Expected 7, got {result}"


if __name__ == '__main__':
    import sys

    tests = [
        test_addition,
        test_subtraction,
        test_multiplication,
        test_division,
        test_division_float,
        test_division_by_zero,
        test_floating_point,
        test_floating_point_mixed,
        test_floating_point_subtraction,
        test_operator_precedence,
        test_operator_precedence2,
        test_operator_precedence3,
        test_parentheses,
        test_parentheses_nested,
        test_parentheses_complex,
        test_negative_start,
        test_large_expression,
        test_whitespace_handling,
        test_empty_input,
        test_whitespace_only_input,
        test_subtraction_negative_result,
        test_multiple_operations,
        test_mixed_operators,
    ]

    failed = 0
    for test_fn in tests:
        try:
            test_fn()
            print(f"  PASS  {test_fn.__name__}")
        except AssertionError as e:
            print(f"  FAIL  {test_fn.__name__}: {e}")
            failed += 1
        except Exception as e:
            print(f"  FAIL  {test_fn.__name__}: {type(e).__name__}: {e}")
            failed += 1

    total = len(tests)
    passed = total - failed
    print(f"\n{passed}/{total} tests passed")
    sys.exit(0 if failed == 0 else 1)