"""Statistical utility functions: mean, median, and population stddev."""

import math


def mean(values):
    """Compute the arithmetic mean of a list of numbers."""
    return sum(values) / len(values)


def median(values):
    """Compute the median of a list of numbers.

    Handles both odd and even length lists.
    """
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    mid = n // 2
    if n % 2 == 1:
        return sorted_vals[mid]
    else:
        return (sorted_vals[mid - 1] + sorted_vals[mid]) / 2


def stddev(values):
    """Compute the population standard deviation of a list of numbers."""
    m = mean(values)
    variance = sum((x - m) ** 2 for x in values) / len(values)
    return math.sqrt(variance)


if __name__ == "__main__":
    data = [1, 2, 3, 4, 5]
    print(f"Data: {data}")
    print(f"mean: {mean(data)}")
    print(f"median: {median(data)}")
    print(f"stddev: {stddev(data)}")

    data2 = [1, 2, 3, 4, 5, 6]
    print(f"\nData: {data2}")
    print(f"mean: {mean(data2)}")
    print(f"median: {median(data2)}")
    print(f"stddev: {stddev(data2)}")