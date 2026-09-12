# Agent metrics

Read from 355 stored sessions on this branch. Nothing here is recorded specially: every number is something the agents already wrote down while working.

Generated 2026-09-12.

## Tokens

116,115,789 tokens over 408 runs that reported them. **98.9% of that is prompt** — what the agents were made to read, not what they wrote. Anything spent on making runs cheaper belongs on that side.

No money here, deliberately: of the four providers only one reports a cost, and a price table goes quietly stale and then prints confident wrong numbers. Multiply by a rate you know.

| | p50 | p90 | p99 | max | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| tokens per run | 24,454 | 284,011 | 5,198,798 | 39,737,697 | 116,115,789 |

## Sessions

| | p50 | p90 | p99 | max | total |
| --- | ---: | ---: | ---: | ---: | ---: |
| messages per session | 10 | 90 | 433 | 1,011 | 12,799 |

| agent | sessions | share |
| --- | ---: | ---: |
| `reviewer` | 236 | 66.5% |
| `engineer` | 82 | 23.1% |
| `orchestrator` | 37 | 10.4% |

## Tools

Failure is counted by the result reading as an error, which is a string match and so an estimate. A high rate is worth looking at either way: it is either a tool that breaks or a tool the prompt points at wrongly.

| tool | calls | failed | rate |
| --- | ---: | ---: | ---: |
| `shell__shell_execute` | 2,265 | 748 | 33% |
| `shell__terminal_operate` | 587 | 333 | 56.7% |
| `filesystem__read_text_file` | 516 | 42 | 8.1% |
| `filesystem_readonly__read_file` | 351 | 11 | 3.1% |
| `filesystem__list_directory` | 248 | 5 | 2% |
| `github__check_merge_readiness` | 221 | 1 | 0.5% |
| `filesystem__write_file` | 194 | 4 | 2.1% |
| `github__get_issue` | 179 | 22 | 12.3% |
| `filesystem_readonly__list_directory` | 171 | 0 | 0% |
| `atoma_builtin__load_skill` | 169 | 75 | 44.4% |
| `github__submit_pr_review` | 107 | 29 | 27.1% |
| `github__commit_and_push` | 84 | 52 | 61.9% |
| `github__search_code` | 84 | 31 | 36.9% |
| `search__search_code` | 68 | 0 | 0% |
| `github__get_pr` | 67 | 10 | 14.9% |
| `filesystem__create_directory` | 66 | 12 | 18.2% |
| `filesystem__edit_file` | 55 | 6 | 10.9% |
| `github__get_check_runs` | 53 | 6 | 11.3% |
| `github__create_pr` | 51 | 24 | 47.1% |
| `filesystem__read_multiple_files` | 48 | 0 | 0% |
| `github__get_pr_diff` | 47 | 4 | 8.5% |
| `filesystem__search_files` | 44 | 43 | 97.7% |
| `github__get_issue_comments` | 40 | 8 | 20% |
| `github__create_issue` | 35 | 4 | 11.4% |
| `github__merge_pr` | 32 | 1 | 3.1% |
| `github__close_issue` | 31 | 13 | 41.9% |
| `github__list_issues` | 31 | 3 | 9.7% |
| `filesystem_readonly__read_text_file` | 29 | 29 | 100% |
| `github__list_prs` | 29 | 0 | 0% |
| `search__search_issues` | 29 | 4 | 13.8% |
| `web__fetch` | 29 | 1 | 3.4% |
| `github__get_branch` | 28 | 13 | 46.4% |
| `github__get_pr_reviews` | 28 | 1 | 3.6% |
| `filesystem__directory_tree` | 26 | 26 | 100% |
| `shell__terminal_list` | 26 | 21 | 80.8% |
| `filesystem_readonly__search_files` | 21 | 21 | 100% |
| `filesystem_readonly__directory_tree` | 20 | 20 | 100% |
| `filesystem__get_file_info` | 18 | 6 | 33.3% |
| `atoma__launch_sub_agent` | 17 | 0 | 0% |
| `filesystem_readonly__read_multiple_files` | 15 | 0 | 0% |
| `filesystem__list_allowed_directories` | 14 | 0 | 0% |
| `filesystem_readonly__list_allowed_directories` | 14 | 14 | 100% |
| `filesystem__read_file` | 12 | 0 | 0% |
| `shell__terminal_close` | 12 | 4 | 33.3% |
| `atoma__request_close_issue` | 11 | 1 | 9.1% |
| `shell__shell_set_default_workdir` | 11 | 2 | 18.2% |
| `github__sync_branch` | 8 | 7 | 87.5% |
| `github__list_pr_review_comments` | 4 | 0 | 0% |
| `shell__command_history_query` | 4 | 2 | 50% |
| `filesystem_readonly__edit_file` | 3 | 3 | 100% |
| `filesystem_readonly__write_file` | 3 | 3 | 100% |
| `shell__terminal_get_info` | 3 | 0 | 0% |
| `filesystem_readonly__get_file_info` | 2 | 0 | 0% |
| `search_files` | 2 | 2 | 100% |
| `shell__execute` | 2 | 2 | 100% |
| `shell__list_execution_outputs` | 2 | 2 | 100% |
| `shell__process_get_execution` | 2 | 1 | 50% |
| `shell__read_execution_output` | 2 | 1 | 50% |
| `bun__run__synth__check__fix__the__dist__git__is__stale__with__the__source__changes` | 1 | 1 | 100% |
| `filesystem__delete_file` | 1 | 1 | 100% |
| `filesystem__move_file` | 1 | 0 | 0% |
| `filesystem__search_code` | 1 | 1 | 100% |
| `filesystem_readonly__list_directory_with_sizes` | 1 | 1 | 100% |
| `github__add_issue_comment` | 1 | 0 | 0% |
| `read_multiple_files` | 1 | 1 | 100% |
| `shell__ssh_execute` | 1 | 1 | 100% |
| `shell__terminals_terminal_operate` | 1 | 1 | 100% |
| `shell__write_file` | 1 | 1 | 100% |
| `terminal_operate` | 1 | 1 | 100% |
| `web__search` | 1 | 1 | 100% |

### Servers never used

Every tool a server offers is described in the prompt of every run. These have never been called:

- `atoma_env`

## Shell activity

What the agents do when they reach for a shell. `search` without a matching `open` is the shape that produced this project's most expensive runs; `edit` against `verify` is the shape that turned out not to occur at all.

| act | calls | share |
| --- | ---: | ---: |
| `other` | 986 | 43.5% |
| `search` | 807 | 35.6% |
| `open` | 259 | 11.4% |
| `verify` | 149 | 6.6% |
| `edit` | 64 | 2.8% |

Hooks refused 175 calls.

## Skills

| skill | loads | share |
| --- | ---: | ---: |
| `review/quick-quality-gate` | 34 | 36.2% |
| `project/conventions` | 22 | 23.4% |
| `delivery/implementation-handoff` | 18 | 19.1% |
| `delivery/issue-decomposition` | 8 | 8.5% |
| `engineering/tdd` | 5 | 5.3% |
| `engineering/debugging` | 3 | 3.2% |
| `engineering/environment` | 2 | 2.1% |
| `research/web-search` | 2 | 2.1% |

### Never loaded

Every skill has been loaded at least once.
