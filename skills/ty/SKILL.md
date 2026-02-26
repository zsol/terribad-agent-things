---
name: ty
description: "Python type checking and code navigation with ty. Use ty_check for diagnostics, ty_goto for definitions, ty_references for usages, ty_hover for type info and docstrings."
---

# ty - Python Type Checker & Code Navigation

Use this skill when working with Python code that needs type checking, diagnostics, or code navigation (finding definitions, references, viewing docstrings).

## Overview

`ty` is an extremely fast Python type checker from Astral (makers of ruff and uv). Use it to:
- Check for type errors in Python files
- Navigate to symbol definitions
- Find all references to a symbol
- View type information and docstrings

## Virtualenv Handling

The extension **automatically detects uv-managed projects** (by checking for `uv.lock`) and runs ty via `uv run ty` to ensure the correct virtualenv is used. This means:
- Third-party type stubs are resolved correctly
- Project dependencies are visible to ty
- No manual virtualenv activation needed

For non-uv projects, ty is invoked directly and uses its own environment detection.

## Tools Available

### ty_check — Type Checking
Run type checks on files or directories.

```
ty_check                           # Check entire project
ty_check path="src/module.py"      # Check specific file
ty_check python_version="3.11"     # Specify Python version
ty_check ignore=["unresolved-import"]  # Ignore specific rules
```

### ty_goto — Go to Definition
Find where a symbol is defined. Position cursor on the symbol you want to look up.

```
ty_goto file="src/main.py" line=10 column=15
```

Use this when you need to:
- Find where a function/class is implemented
- Jump to an import's source
- Understand what a variable refers to

### ty_references — Find References
Find all usages of a symbol across the codebase.

```
ty_references file="src/main.py" line=10 column=15
ty_references file="src/main.py" line=10 column=15 include_declaration=false
```

Use this when you need to:
- See everywhere a function is called
- Find all usages before renaming
- Understand the impact of changing an API

### ty_hover — Type Info & Docs
Get type information and documentation for a symbol.

```
ty_hover file="src/main.py" line=10 column=15
```

Use this when you need to:
- See the inferred type of a variable
- View function signatures
- Read docstrings without opening the file

## Code Navigation Workflow

When exploring an unfamiliar Python codebase:

1. **Start with diagnostics** — Run `ty_check` to understand the health of the codebase
2. **Explore entry points** — Use `ty_goto` to follow imports and function calls
3. **Understand usage patterns** — Use `ty_references` to see how APIs are used
4. **Check types and docs** — Use `ty_hover` to understand interfaces

### Finding the column number

The `line` parameter is straightforward (1-indexed line number). For `column`:
- Count characters from the start of the line (1-indexed)
- Position on the first character of the symbol name
- Example: In `result = calculate_total(items)`, to look up `calculate_total`:
  - If line is `    result = calculate_total(items)`
  - `calculate_total` starts at column 14 (after 4 spaces + `result = `)

Tip: Use the `read` tool first to see the line content, then count to find the column.

## Interpreting Type Check Results

Diagnostics include:
- **file**: Path to the file with the issue
- **line/column**: Location of the error
- **severity**: `error` or `warning`
- **rule**: The rule code (e.g., `invalid-return-type`, `invalid-assignment`)
- **message**: Description of the issue

Common rule codes:
- `invalid-return-type` — Function returns wrong type
- `invalid-assignment` — Value assigned doesn't match declared type
- `unresolved-import` — Import cannot be resolved
- `unresolved-attribute` — Attribute doesn't exist on type
- `invalid-argument-type` — Wrong argument type passed to function
- `missing-argument` — Required argument not provided
- `possibly-unbound` — Variable may not be defined in all code paths

## Configuration

ty reads configuration from `pyproject.toml` under `[tool.ty]` or from `ty.toml`.

```toml
[tool.ty]
python-version = "3.11"

[tool.ty.rules]
warn = ["possibly-unbound-variable"]
ignore = ["missing-return-type"]
```
