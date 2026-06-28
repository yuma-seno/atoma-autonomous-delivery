"""
calc.py - A command-line calculator with a hand-written parser.

Reads expressions from stdin, one per line, and evaluates them.
Supports +, -, *, / with operator precedence and parentheses.
Uses the shunting-yard algorithm (no eval()).
"""

import sys
import operator


# --- Tokenizer ---

def tokenize(expr):
    """Convert an expression string into a list of tokens."""
    tokens = []
    i = 0
    while i < len(expr):
        ch = expr[i]
        if ch.isspace():
            i += 1
            continue
        # Handle unary minus: check if '-' is at start or after an operator/'(/['
        if ch == '-':
            # Find the previous non-whitespace character to determine if this is unary
            prev_nonspace = None
            for k in range(i - 1, -1, -1):
                if not expr[k].isspace():
                    prev_nonspace = expr[k]
                    break
            if prev_nonspace is None or prev_nonspace in '+-*/([':
                # Unary minus
                j = i + 1
                # Skip whitespace between '-' and the number
                while j < len(expr) and expr[j].isspace():
                    j += 1
                if j < len(expr) and (expr[j].isdigit() or expr[j] == '.'):
                    # Parse as a negative number
                    i = j
                    has_dot = False
                    while j < len(expr) and (expr[j].isdigit() or (expr[j] == '.' and not has_dot)):
                        if expr[j] == '.':
                            has_dot = True
                        j += 1
                    num_str = expr[i:j]
                    if has_dot:
                        tokens.append(('NUM', -float(num_str)))
                    else:
                        tokens.append(('NUM', -int(num_str)))
                    i = j
                    continue
                # Unary minus without number, treat as binary minus with 0
                tokens.append(('NUM', 0))
                tokens.append(('OP', '-'))
                i += 1
                continue
        if ch.isdigit() or ch == '.':
            # Parse a number (integer or float)
            j = i
            has_dot = False
            while j < len(expr) and (expr[j].isdigit() or (expr[j] == '.' and not has_dot)):
                if expr[j] == '.':
                    has_dot = True
                j += 1
            num_str = expr[i:j]
            if has_dot:
                tokens.append(('NUM', float(num_str)))
            else:
                tokens.append(('NUM', int(num_str)))
            i = j
            continue
        if ch in '+-*/()':
            tokens.append(('OP', ch))
            i += 1
            continue
        # Unknown character, skip
        i += 1
    return tokens


# --- Shunting-Yard: Infix -> RPN (postfix) ---

PRECEDENCE = {
    '+': 1,
    '-': 1,
    '*': 2,
    '/': 2,
}


def infix_to_rpn(tokens):
    """Convert infix token list to Reverse Polish Notation using shunting-yard."""
    output = []
    op_stack = []

    for tok_type, tok_val in tokens:
        if tok_type == 'NUM':
            output.append(('NUM', tok_val))
        elif tok_type == 'OP':
            if tok_val == '(':
                op_stack.append(tok_val)
            elif tok_val == ')':
                # Pop operators until '('
                while op_stack and op_stack[-1] != '(':
                    output.append(('OP', op_stack.pop()))
                if op_stack and op_stack[-1] == '(':
                    op_stack.pop()  # Discard '('
            else:
                # Operator
                while (op_stack and op_stack[-1] != '('
                       and PRECEDENCE.get(op_stack[-1], 0) >= PRECEDENCE.get(tok_val, 0)):
                    output.append(('OP', op_stack.pop()))
                op_stack.append(tok_val)

    # Pop remaining operators
    while op_stack:
        output.append(('OP', op_stack.pop()))

    return output


# --- RPN Evaluator ---

OPS = {
    '+': operator.add,
    '-': operator.sub,
    '*': operator.mul,
    '/': operator.truediv,
}


def eval_rpn(rpn_tokens):
    """Evaluate a Reverse Polish Notation expression."""
    stack = []

    for tok_type, tok_val in rpn_tokens:
        if tok_type == 'NUM':
            stack.append(tok_val)
        elif tok_type == 'OP':
            if len(stack) < 2:
                raise ValueError("Invalid expression")
            b = stack.pop()
            a = stack.pop()
            op_func = OPS.get(tok_val)
            if op_func is None:
                raise ValueError(f"Unknown operator: {tok_val}")
            if tok_val == '/' and b == 0:
                raise ZeroDivisionError("Division by zero")
            result = op_func(a, b)
            # Convert to int if result is a whole number
            if isinstance(result, float) and result == int(result):
                result = int(result)
            stack.append(result)

    if len(stack) != 1:
        raise ValueError("Invalid expression")

    return stack[0]


# --- High-level evaluate function ---

def evaluate(expr):
    """Evaluate a single expression string and return the result."""
    tokens = tokenize(expr)
    if not tokens:
        return None
    rpn = infix_to_rpn(tokens)
    return eval_rpn(rpn)


# --- CLI ---

def main():
    """Main entry point: read from stdin, evaluate line by line."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            result = evaluate(line)
            if result is not None:
                print(result)
        except ZeroDivisionError:
            print("Error: Division by zero")
        except Exception as e:
            print(f"Error: {e}")


if __name__ == '__main__':
    main()