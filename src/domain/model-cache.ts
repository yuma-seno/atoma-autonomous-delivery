/**
 * model-cache.ts — where the reranker's weights live, named once.
 *
 * Three places have to agree on this directory and none of them can see the
 * others: the search server points transformers.js at it, the runner tells
 * `actions/cache` to keep it between runs, and the runner's ACLs decide who may
 * write it. A disagreement between any two of them is silent — the model
 * downloads again, or fails to, and every search still answers, worse.
 *
 * That is not hypothetical. #499 was this directory being unwritable: the load
 * failed with EACCES, reranking fell back to a first-stage order, and two releases
 * went out before anyone read a log. The path is a constant for the same reason
 * `domain/workspace.ts` holds one.
 *
 * A name rather than a full path, because the base is different in each place --
 * `$XDG_CACHE_HOME` inside the server, `${{ runner.temp }}/atoma-tool-cache` in an
 * action input that cannot read a shell variable.
 */
export const MODEL_CACHE_DIR = "atoma-transformers";
