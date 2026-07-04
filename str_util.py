"""Simple string utility functions."""


def reverse(s: str) -> str:
    """Return the reversed version of the given string."""
    return s[::-1]


def count_words(s: str) -> int:
    """Return the number of words in the given string.

    Words are sequences of characters separated by whitespace.
    """
    return len(s.split())


def is_palindrome(s: str) -> bool:
    """Return True if the string is a palindrome, ignoring case and non-alphanumeric characters."""
    cleaned = "".join(ch.lower() for ch in s if ch.isalnum())
    return cleaned == cleaned[::-1]


if __name__ == "__main__":
    # --- reverse tests ---
    assert reverse("hello") == "olleh"
    assert reverse("") == ""
    assert reverse("a") == "a"
    assert reverse("12345") == "54321"
    print("✓ reverse: all tests passed")

    # --- count_words tests ---
    assert count_words("hello world") == 2
    assert count_words("") == 0
    assert count_words("one") == 1
    assert count_words("  leading and trailing  ") == 3
    print("✓ count_words: all tests passed")

    # --- is_palindrome tests ---
    assert is_palindrome("racecar") is True
    assert is_palindrome("hello") is False
    assert is_palindrome("A man, a plan, a canal: Panama") is True
    assert is_palindrome("") is True
    assert is_palindrome("No 'x' in Nixon") is True
    print("✓ is_palindrome: all tests passed")

    print("\nAll tests passed!")