"""CLI calculator with add, sub, mul, div commands.

Usage:
    python calc_cli.py add <a> <b>
    python calc_cli.py sub <a> <b>
    python calc_cli.py mul <a> <b>
    python calc_cli.py div <a> <b>
"""

import argparse
import sys


def create_parser() -> argparse.ArgumentParser:
    """Build and return the argument parser.

    Returns:
        An ArgumentParser instance with all subcommands configured.
    """
    parser = argparse.ArgumentParser(
        prog="calc_cli.py",
        description="A simple CLI calculator.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    for cmd in ("add", "sub", "mul", "div"):
        sub = subparsers.add_parser(cmd, help=f"Perform {cmd} operation")
        sub.add_argument("a", type=float, help="First operand")
        sub.add_argument("b", type=float, help="Second operand")

    return parser


def run_add(a: float, b: float) -> None:
    """Add two numbers and print the result."""
    print(a + b)


def run_sub(a: float, b: float) -> None:
    """Subtract b from a and print the result."""
    print(a - b)


def run_mul(a: float, b: float) -> None:
    """Multiply two numbers and print the result."""
    print(a * b)


def run_div(a: float, b: float) -> None:
    """Divide a by b and print the result.

    Exits with code 1 on division by zero.
    """
    if b == 0.0:
        print("Error: division by zero", file=sys.stderr)
        sys.exit(1)
    print(a / b)


def main(argv: list[str] | None = None) -> None:
    """Entry point for the CLI.

    Args:
        argv: Command-line arguments (defaults to sys.argv[1:]).
    """
    parser = create_parser()
    args = parser.parse_args(argv)

    if args.command == "add":
        run_add(args.a, args.b)
    elif args.command == "sub":
        run_sub(args.a, args.b)
    elif args.command == "mul":
        run_mul(args.a, args.b)
    elif args.command == "div":
        run_div(args.a, args.b)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()