use super::{get_bool, get_int, get_str, get_str_or, resolve_path, Args};
use crate::ToolContext;
use anyhow::{bail, Result};
use std::process::Command;

pub fn run(args: &Args, ctx: &ToolContext) -> Result<String> {
    let pattern = get_str(args, "pattern");
    if pattern.is_empty() {
        bail!("pattern is required");
    }
    let search_path = resolve_path(ctx, get_str_or(args, "path", "."));
    let output_mode = get_str_or(args, "output_mode", "content");
    let head_limit = get_int(args, "head_limit", 50);
    let context_lines = get_int(args, "context", 0);
    let case_insensitive = get_bool(args, "case_insensitive", false);
    let multiline = get_bool(args, "multiline", false);
    let glob_filter = get_str(args, "glob");
    let type_filter = get_str(args, "type");

    let mut rg_args = vec![
        "--no-heading".to_string(),
        "--line-number".to_string(),
        "--max-filesize".to_string(),
        "1M".to_string(),
        "--max-columns".to_string(),
        "500".to_string(),
    ];

    match output_mode {
        "files_with_matches" => rg_args.push("--files-with-matches".into()),
        "count" => rg_args.push("--count".into()),
        _ => {
            if head_limit > 0 {
                rg_args.push("--max-count".into());
                rg_args.push(head_limit.to_string());
            }
        }
    }

    if context_lines > 0 {
        rg_args.push(format!("-C{context_lines}"));
    }
    if case_insensitive {
        rg_args.push("-i".into());
    }
    if multiline {
        rg_args.extend_from_slice(&["-U".into(), "--multiline-dotall".into()]);
    }
    if !glob_filter.is_empty() {
        rg_args.extend_from_slice(&["--glob".into(), glob_filter.to_string()]);
    }
    if !type_filter.is_empty() {
        rg_args.extend_from_slice(&["--type".into(), type_filter.to_string()]);
    }

    // ripgrep already honours .gitignore; `.sidexignore` is the assistant's
    // own blocklist and has to be passed explicitly. Both the search root and
    // the workspace root are considered so a search inside a subdirectory
    // still respects the workspace-level file.
    for ignore_file in sidexignore_files(&search_path, &ctx.cwd) {
        rg_args.extend_from_slice(&["--ignore-file".into(), ignore_file]);
    }

    rg_args.push("--".into());
    rg_args.push(pattern.to_string());
    rg_args.push(search_path);

    let output = Command::new("rg").args(&rg_args).output();

    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let stderr = String::from_utf8_lossy(&o.stderr);
            let combined = format!("{stdout}{stderr}");
            if combined.trim().is_empty() {
                Ok("(no matches)".into())
            } else {
                Ok(combined)
            }
        }
        Err(e) => bail!("failed to run rg: {e}"),
    }
}

/// Existing `.sidexignore` files that apply to a search rooted at
/// `search_path` inside the workspace at `cwd`.
fn sidexignore_files(search_path: &str, cwd: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for dir in [search_path, cwd] {
        let candidate = std::path::Path::new(dir).join(".sidexignore");
        if candidate.is_file() {
            let path = candidate.display().to_string();
            if !out.contains(&path) {
                out.push(path);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::sidexignore_files;

    #[test]
    fn finds_sidexignore_in_both_roots() {
        let base = std::env::temp_dir().join(format!(
            "sidex-grep-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let workspace = base.join("ws");
        let nested = workspace.join("src");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(workspace.join(".sidexignore"), "secret/\n").unwrap();
        std::fs::write(nested.join(".sidexignore"), "*.log\n").unwrap();

        let roots = sidexignore_files(nested.to_str().unwrap(), workspace.to_str().unwrap());
        assert_eq!(roots.len(), 2);

        let only_workspace = sidexignore_files(
            workspace.join("missing").to_str().unwrap(),
            workspace.to_str().unwrap(),
        );
        assert_eq!(only_workspace.len(), 1);

        std::fs::remove_dir_all(&base).ok();
    }
}
