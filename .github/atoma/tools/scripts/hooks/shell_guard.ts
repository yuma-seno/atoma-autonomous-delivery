#!/usr/bin/env bun
// @bun
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);

// node_modules/shell-quote/quote.js
var require_quote = __commonJS((exports, module) => {
  var OPS = [
    "||",
    "&&",
    ";;",
    "|&",
    "<(",
    "<<<",
    ">>",
    ">&",
    "<&",
    "&",
    ";",
    "(",
    ")",
    "|",
    "<",
    ">"
  ];
  var LINE_TERMINATORS = /[\n\r\u2028\u2029]/;
  var GLOB_SHELL_SPECIAL = /[\s#!"$&'():;<=>@\\^`|]/g;
  module.exports = function quote(xs) {
    return xs.map(function(s) {
      if (s === "") {
        return "''";
      }
      if (s && typeof s === "object") {
        if ("op" in s && s.op === "glob") {
          if (typeof s.pattern !== "string") {
            throw new TypeError("glob token requires a string `pattern`");
          }
          if (LINE_TERMINATORS.test(s.pattern)) {
            throw new TypeError("glob `pattern` must not contain line terminators");
          }
          return s.pattern.replace(GLOB_SHELL_SPECIAL, "\\$&");
        }
        if ("op" in s && typeof s.op === "string") {
          if (OPS.indexOf(s.op) < 0) {
            throw new TypeError("invalid `op` value: " + JSON.stringify(s.op));
          }
          return s.op.replace(/[\s\S]/g, "\\$&");
        }
        if ("comment" in s && typeof s.comment === "string") {
          if (LINE_TERMINATORS.test(s.comment)) {
            throw new TypeError("`comment` must not contain line terminators");
          }
          return "#" + s.comment;
        }
        throw new TypeError("unrecognized object token shape");
      }
      if (/["\s\\]/.test(s) && !/'/.test(s)) {
        return "'" + s.replace(/(['])/g, "\\$1") + "'";
      }
      if (/["'\s]/.test(s)) {
        return '"' + s.replace(/(["\\$`!])/g, "\\$1") + '"';
      }
      return String(s).replace(/([A-Za-z]:)?([#!"$&'()*,:;<=>?@[\\\]^`{|}~])/g, "$1\\$2");
    }).join(" ");
  };
});

// node_modules/shell-quote/parse.js
var require_parse = __commonJS((exports, module) => {
  var CONTROL = "(?:" + [
    "\\|\\|",
    "\\&\\&",
    ";;",
    "\\|\\&",
    "\\<\\(",
    "\\<\\<\\<",
    ">>",
    ">\\&",
    "<\\&",
    "[&;()|<>]"
  ].join("|") + ")";
  var controlRE = new RegExp("^" + CONTROL + "$");
  var META = "|&;()<> \\t";
  var SINGLE_QUOTE = "'([^']*?)'";
  var DOUBLE_QUOTE = '"((\\\\"|[^"])*?)"';
  var hash = /^#$/;
  var SQ = "'";
  var DQ = '"';
  var DS = "$";
  var TOKEN = "";
  var mult = 4294967296;
  for (i = 0;i < 4; i++) {
    TOKEN += (mult * Math.random()).toString(16);
  }
  var i;
  var startsWithToken = new RegExp("^" + TOKEN);
  function matchAll(s, r) {
    var origIndex = r.lastIndex;
    var matches = [];
    var matchObj;
    while (matchObj = r.exec(s)) {
      matches[matches.length] = matchObj;
      if (r.lastIndex === matchObj.index) {
        r.lastIndex += 1;
      }
    }
    r.lastIndex = origIndex;
    return matches;
  }
  function getVar(env, pre, key) {
    var r = typeof env === "function" ? env(key) : env[key];
    if (typeof r === "undefined" && key != "") {
      r = "";
    } else if (typeof r === "undefined") {
      r = "$";
    }
    if (typeof r === "object") {
      return pre + TOKEN + JSON.stringify(r) + TOKEN;
    }
    return pre + r;
  }
  function parseInternal(string, env, opts) {
    if (!opts) {
      opts = {};
    }
    var BS = opts.escape || "\\";
    var ifs = opts.splitUnquoted === true ? ` 	
` : typeof opts.splitUnquoted === "string" ? opts.splitUnquoted : "";
    var BAREWORD = "(\\" + BS + `['"` + META + `]|[^\\s'"` + META + "])+";
    var chunker = new RegExp([
      "(" + CONTROL + ")",
      "(" + BAREWORD + "|" + DOUBLE_QUOTE + "|" + SINGLE_QUOTE + ")+"
    ].join("|"), "g");
    var matches = matchAll(string, chunker);
    if (matches.length === 0) {
      return [];
    }
    if (!env) {
      env = {};
    }
    var commented = false;
    return matches.map(function(match) {
      var s = match[0];
      if (!s || commented) {
        return;
      }
      if (controlRE.test(s)) {
        return { op: s };
      }
      var quote = false;
      var esc = false;
      var out = "";
      var words = [];
      var sawQuote = false;
      var pendingNw = null;
      var isGlob = false;
      var i2;
      function parseEnvVar() {
        i2 += 1;
        var varend;
        var varname;
        var char = s.charAt(i2);
        if (char === "{") {
          i2 += 1;
          if (s.charAt(i2) === "}") {
            throw new Error("Bad substitution: " + s.slice(i2 - 2, i2 + 1));
          }
          var depth = 1;
          varend = i2;
          while (depth > 0 && varend < s.length) {
            if (s.charAt(varend) === "{" && s.charAt(varend - 1) === "$") {
              depth += 1;
            } else if (s.charAt(varend) === "}") {
              depth -= 1;
            }
            varend += 1;
          }
          if (depth !== 0) {
            throw new Error("Bad substitution: " + s.slice(i2));
          }
          varend -= 1;
          varname = s.slice(i2, varend);
          i2 = varend;
        } else if (/[*@#?$!_-]/.test(char)) {
          varname = char;
          i2 += 1;
        } else {
          var slicedFromI = s.slice(i2);
          varend = slicedFromI.match(/[^\w\d_]/);
          if (!varend) {
            varname = slicedFromI;
            i2 = s.length;
          } else {
            varname = slicedFromI.slice(0, varend.index);
            i2 += varend.index - 1;
          }
        }
        return getVar(env, "", varname);
      }
      function flushRun() {
        if (pendingNw === null) {
          return;
        }
        if (pendingNw === 0) {
          if (out !== "") {
            words[words.length] = out;
            out = "";
          }
        } else {
          words[words.length] = out;
          out = "";
          for (var fe = 1;fe < pendingNw; fe += 1) {
            words[words.length] = "";
          }
        }
        pendingNw = null;
      }
      for (i2 = 0;i2 < s.length; i2++) {
        var c = s.charAt(i2);
        if (ifs && c !== DS) {
          flushRun();
        }
        isGlob = isGlob || !quote && (c === "*" || c === "?");
        if (esc) {
          out += c;
          esc = false;
        } else if (quote) {
          if (c === quote) {
            quote = false;
          } else if (quote == SQ) {
            out += c;
          } else {
            if (c === BS) {
              i2 += 1;
              c = s.charAt(i2);
              if (c === DQ || c === BS || c === DS) {
                out += c;
              } else {
                out += BS + c;
              }
            } else if (c === DS) {
              out += parseEnvVar();
            } else {
              out += c;
            }
          }
        } else if (c === DQ || c === SQ) {
          quote = c;
          sawQuote = true;
        } else if (controlRE.test(c)) {
          return { op: s };
        } else if (hash.test(c)) {
          commented = true;
          var commentObj = { comment: string.slice(match.index + i2 + 1) };
          if (out.length) {
            return [out, commentObj];
          }
          return [commentObj];
        } else if (c === BS) {
          esc = true;
        } else if (c === DS) {
          var value = parseEnvVar();
          if (!ifs) {
            out += value;
          } else {
            for (var vi = 0;vi < value.length; vi += 1) {
              var vc = value.charAt(vi);
              if (ifs.indexOf(vc) < 0) {
                flushRun();
                out += vc;
              } else if (pendingNw === null) {
                pendingNw = vc === " " || vc === "\t" || vc === `
` ? 0 : 1;
              } else if (vc !== " " && vc !== "\t" && vc !== `
`) {
                pendingNw += 1;
              }
            }
          }
        } else {
          out += c;
        }
      }
      if (isGlob) {
        return { op: "glob", pattern: out };
      }
      if (ifs) {
        if (pendingNw !== null && pendingNw > 0) {
          words[words.length] = out;
          out = "";
          for (var te = 1;te < pendingNw; te += 1) {
            words[words.length] = "";
          }
        }
        if (out !== "" || sawQuote && words.length === 0) {
          words[words.length] = out;
        }
        return words;
      }
      return out;
    }).reduce(function(prev, arg) {
      if (typeof arg === "undefined") {
        return prev;
      }
      [].concat(arg).forEach(function(entry) {
        prev[prev.length] = entry;
      });
      return prev;
    }, []);
  }
  module.exports = function parse(s, env, opts) {
    var mapped = parseInternal(s, env, opts);
    if (typeof env !== "function") {
      return mapped;
    }
    return mapped.reduce(function(acc, s2) {
      if (typeof s2 === "object") {
        acc[acc.length] = s2;
        return acc;
      }
      var xs = s2.split(RegExp("(" + TOKEN + ".*?" + TOKEN + ")", "g"));
      if (xs.length === 1) {
        acc[acc.length] = xs[0];
        return acc;
      }
      xs.filter(Boolean).forEach(function(x) {
        acc[acc.length] = startsWithToken.test(x) ? JSON.parse(x.split(TOKEN)[1]) : x;
      });
      return acc;
    }, []);
  };
});

// src/atoma/tools/scripts/hooks/shell_guard.ts
import { resolve, sep } from "path";

// node_modules/shell-quote/index.js
var $quote = require_quote();
var $parse = require_parse();

// src/atoma/tools/scripts/hooks/shell_guard.ts
var BLOCKED = [
  [/\bgh\b/, "gh CLI is disabled. Use the atoma_github MCP tools (github__create_pr, github__create_issue, etc.) for GitHub operations."],
  [/\bcurl\b/, "curl is disabled. Use MCP tools for external data."],
  [/\bwget\b/, "wget is disabled."],
  [/\bssh\b/, "ssh is disabled."],
  [/\bscp\b/, "scp is disabled."],
  [/\brsync\b/, "rsync is disabled."],
  [/\bpython3?\s.*-[cC]\b/, "python -c is disabled."],
  [/\bruby\s.*-[eE]\b/, "ruby -e is disabled."],
  [/\bperl\s.*-[eE]\b/, "perl -e is disabled."],
  [/\bnode\s.*-[eE]\b/, "node -e is disabled."],
  [/\bpython3?\s+<</, "python heredoc is disabled."],
  [/\bruby\s+<</, "ruby heredoc is disabled."],
  [/\bperl\s+<</, "perl heredoc is disabled."],
  [/\bnode\s+<</, "node heredoc is disabled."],
  [/\bbase64\b.*\|\s*(?:sh|bash|zsh|dash)/, "base64 pipe-to-shell is disabled."],
  [/\bxxd\b.*\|\s*(?:sh|bash|zsh|dash)/, "binary pipe-to-shell is disabled."],
  [
    /^(?=[\s\S]*\/proc)(?=[\s\S]*\benviron\b)/,
    "Reading a process's environment through /proc is disabled."
  ],
  [/(?:^|\s|\||;)\beval\b/, "eval is disabled."],
  [/(?:^|\s|\||;)\bexec\b/, "exec is disabled."],
  [/(?:^|\s|;)\bsource\b/, "source is disabled."],
  [/(?:^|\s|\||;)\.\s+/, "source (.) is disabled."],
  [/\bsh\s+(?:-[a-zA-Z]+\s+)*-c\b/, "sh -c is disabled."],
  [/\bbash\s+(?:-[a-zA-Z]+\s+)*-c\b/, "bash -c is disabled."],
  [/\bzsh\s+(?:-[a-zA-Z]+\s+)*-c\b/, "zsh -c is disabled."],
  [/\bdash\s+(?:-[a-zA-Z]+\s+)*-c\b/, "dash -c is disabled."]
];
var MUTATING_GIT_COMMANDS = new Set([
  "add",
  "am",
  "apply",
  "bisect",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "config",
  "fetch",
  "init",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "remote",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
  "worktree"
]);
function findMutatingGitCommand(command) {
  for (const segment of command.split(/\s*(?:&&|\|\||[;|])\s*/)) {
    const tokens = segment.trim().split(/\s+/);
    const gitIndex = tokens.findIndex((token) => token === "git" || token.endsWith("/git"));
    if (gitIndex === -1)
      continue;
    let index = gitIndex + 1;
    while (index < tokens.length && tokens[index].startsWith("-")) {
      const option = tokens[index++];
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"].includes(option)) {
        index++;
      }
    }
    const subcommand = tokens[index];
    if (subcommand && MUTATING_GIT_COMMANDS.has(subcommand))
      return subcommand;
  }
  return;
}
function normalizeCommand(command) {
  let tokens;
  try {
    tokens = $parse(command);
  } catch {
    return command;
  }
  let out = "";
  let prevWasOp = false;
  for (const t of tokens) {
    const isOp = typeof t !== "string";
    const text = isOp ? t.op : t;
    if (out.length === 0)
      out = text;
    else if (isOp && prevWasOp)
      out += text;
    else
      out += ` ${text}`;
    prevWasOp = isOp;
  }
  return out;
}
var EXECUTION_CONTROLLING_VARS = new Set([
  "BASH_ENV",
  "ENV",
  "IFS",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "PATH",
  "SHELL",
  "SHELLOPTS"
]);
var STDIN_INTERPRETERS = /^(?:[\w./-]*\/)?(?:sh|bash|zsh|dash|python3?|ruby|perl|node|bun)$/;
function substituteDeclaredVars(command, vars) {
  let out = command;
  for (const name of Object.keys(vars).sort((a, b) => b.length - a.length)) {
    if (!/^\w+$/.test(name))
      continue;
    out = out.split(`\${${name}}`).join(vars[name] ?? "");
    out = out.split(`$${name}`).join(vars[name] ?? "");
  }
  return out;
}
function checkInvocation(invocation) {
  const vars = invocation.environmentVariables ?? {};
  for (const name of Object.keys(vars)) {
    if (EXECUTION_CONTROLLING_VARS.has(name.toUpperCase())) {
      return {
        allow: false,
        reason: `Setting ${name} through environment_variables is disabled: it changes what the command executes, which no inspection of the command text can account for.`
      };
    }
  }
  const cwd = invocation.workingDirectory?.trim();
  if (cwd) {
    const resolved = resolve(cwd);
    const root = resolve(process.cwd());
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      return {
        allow: false,
        reason: `working_directory must stay inside the repository (${root}); '${cwd}' is outside it.`
      };
    }
  }
  if (invocation.inputData !== undefined) {
    const first = normalizeCommand(invocation.command).trim().split(/\s+/)[0] ?? "";
    if (STDIN_INTERPRETERS.test(first)) {
      return {
        allow: false,
        reason: `Piping a script into '${first}' through input_data is disabled, for the same reason '${first} -c' is.`
      };
    }
  }
  const text = [substituteDeclaredVars(invocation.command, vars), invocation.inputData ?? ""].filter(Boolean).join(`
`);
  return checkCommand(text);
}
function checkCommand(command) {
  const normalized = normalizeCommand(command);
  const gitCommand = findMutatingGitCommand(normalized);
  if (gitCommand) {
    return {
      allow: false,
      reason: `Raw 'git ${gitCommand}' is disabled. Use the github__* MCP tools for Git mutations and branch synchronization.`
    };
  }
  for (const [pattern, reason] of BLOCKED) {
    if (pattern.test(normalized))
      return { allow: false, reason };
  }
  return { allow: true, reason: "" };
}
async function main() {
  let data;
  try {
    const raw = await new Response(Bun.stdin.stream()).text();
    data = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({ allow: false, reason: "shell_guard: failed to parse input" }));
    return;
  }
  const args = data.arguments ?? {};
  const command = String(args.command ?? args.cmd ?? args.shell ?? "");
  const { allow, reason } = checkInvocation({
    command,
    workingDirectory: typeof args.working_directory === "string" ? args.working_directory : undefined,
    environmentVariables: args.environment_variables && typeof args.environment_variables === "object" ? args.environment_variables : undefined,
    inputData: typeof args.input_data === "string" ? args.input_data : undefined
  });
  if (allow) {
    console.log(JSON.stringify({ allow: true }));
  } else {
    console.log(JSON.stringify({
      allow: false,
      reason: `Command blocked by shell guard: ${reason} (attempted: ${command.slice(0, 120)})`
    }));
  }
}
if (import.meta.main)
  main();
export {
  checkInvocation
};
