#!/usr/bin/env bash
set -euo pipefail

# Developer wrapper that runs padma from this checkout's latest `npm run build`.
# Development invocations use PADMA_EXPERIMENTAL=1 by default. Pass --stable to use
# the next padma executable on PATH; `padma update` also uses stable so self-update
# works.
#
# From the repository root, install with:
#   mkdir -p "$HOME/.local/bin"
#   ln -s "$PWD/scripts/auto-padma.sh" "$HOME/.local/bin/padma"
#
# ~/.local/bin must appear before the stable padma installation on PATH.

# Resolve this script through symlinks so repo_dir points at the development
# checkout rather than the directory containing the `padma` symlink.
script_path="${BASH_SOURCE[0]}"
while [[ -L "$script_path" ]]; do
	script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
	link_target="$(readlink "$script_path")"
	if [[ "$link_target" == /* ]]; then
		script_path="$link_target"
	else
		script_path="$script_dir/$link_target"
	fi
done
script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

find_stable_padma() {
	local path_entry candidate candidate_dir
	local -a path_entries
	IFS=: read -r -a path_entries <<< "${PATH:-}"
	for path_entry in "${path_entries[@]}"; do
		[[ -n "$path_entry" ]] || path_entry=.
		candidate="$path_entry/padma"
		[[ -x "$candidate" && ! -d "$candidate" ]] || continue
		[[ "$candidate" -ef "$script_path" ]] && continue
		candidate_dir="$(cd -P "$(dirname "$candidate")" && pwd)" || continue
		printf '%s/%s\n' "$candidate_dir" "$(basename "$candidate")"
		return 0
	done
	return 1
}

use_stable=false
args=()
for arg in "$@"; do
	if [[ "$arg" == "--stable" ]]; then
		use_stable=true
	else
		args+=("$arg")
	fi
done

if [[ "${args[0]:-}" == "update" ]]; then
	use_stable=true
fi

if [[ "$use_stable" == true ]]; then
	if ! stable_padma="$(find_stable_padma)"; then
		echo "error: could not find a stable padma executable after the auto-padma wrapper on PATH" >&2
		exit 1
	fi
	exec "$stable_padma" ${args[@]+"${args[@]}"}
fi

dev_padma="$repo_dir/packages/coding-agent/dist/bundle/cli.js"
if [[ ! -x "$dev_padma" ]]; then
	echo "error: development padma build not found; run \`npm run build\` in $repo_dir" >&2
	exit 1
fi

export PADMA_EXPERIMENTAL="${PADMA_EXPERIMENTAL:-1}"
exec "$dev_padma" ${args[@]+"${args[@]}"}
