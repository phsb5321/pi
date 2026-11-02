#!/usr/bin/env bash
# seat-sleep-stub.sh — the half of idle-seat sleep that holds the pane while pi is gone.
#
# The in-process half (`src/core/seat-sleep.ts`) writes <checkpoint> and <checkpoint>.wake, then shuts pi down.
# A resident launcher (the `pi` wrapper) keeps the pane alive after that and runs this script as the pane's
# foreground process:
#
#     exec -a pi bash seat-sleep-stub.sh --checkpoint <checkpoint>
#
# This script prints a banner, reads ONE prompt and execs pi again:
#   * explicit session file from the checkpoint — the primary wake path;
#   * `pi --continue` — only when that session file is gone, because `--continue` is cwd-scoped and latest-wins,
#     so another pi that ran in this directory after the seat slept would be resumed instead;
#   * plain wake text rides in argv (exact bytes, no replay through the tty);
#   * a wake line starting with `/` or `-` cannot be a positional prompt (pi would send it to the model or parse
#     it as a flag), so it is left in the editor via PI_SEAT_SLEEP_DRAFT_FILE and never submitted.
#
# Multi-line paste: a plain `read` returns at the first newline and leaves the rest to land in pi's editor as
# separate prompts. The reader below enables bracketed paste (herdr `pane run` and real terminals then wrap the
# payload), and for an unbracketed burst it treats a newline followed by more input within 250 ms as a line break
# inside the paste rather than as Enter.
#
# Nothing here runs unless this script is started explicitly; the feature is OFF unless PI_SEAT_SLEEP_MIN > 0 and
# a resident launcher set PI_SEAT_SLEEP_LAUNCHER=1 for the pi it replaced.
set -u

checkpoint=""
pi_bin="${PI_SEAT_SLEEP_PI:-pi}"
wait_pid=""

while [ $# -gt 0 ]; do
	case "$1" in
		--checkpoint)
			checkpoint="${2:-}"
			shift 2
			;;
		--pi)
			pi_bin="${2:-pi}"
			shift 2
			;;
		--pid)
			wait_pid="${2:-}"
			shift 2
			;;
		*)
			shift
			;;
	esac
done

[ -n "$checkpoint" ] || exit 0

# The launcher passes the run id it exported for the pi it replaced: a checkpoint from another run (or a normal
# exit that wrote none) means this is not a sleep, so the pane closes as it always did.
if [ -n "$wait_pid" ]; then
	deadline=$(( $(date +%s) + 30 ))
	while kill -0 "$wait_pid" 2>/dev/null; do
		[ "$(date +%s)" -lt "$deadline" ] || break
		sleep 0.05
	done
fi

[ -s "$checkpoint" ] || exit 0
[ -s "$checkpoint.wake" ] || exit 0

# The wake file is written by the extension with shell-quoted values and mode 0600.
# shellcheck disable=SC1090
. "$checkpoint.wake" || exit 0

if [ -n "${PI_SEAT_SLEEP_RUN_ID:-}" ] && [ "${PI_WAKE_RUN_ID:-}" != "$PI_SEAT_SLEEP_RUN_ID" ]; then
	exit 0
fi

line=""
paste=0
closed=0
submitted=0
havep=0
tty_saved=""

printf '\n  zzz  seat asleep (idle checkpoint). Type anything + Enter, or send a herdr-prompt, to resume.\n'
printf '%s\n' '────────────────────────────────────────────────────────────'

if [ -t 0 ]; then
	tty_saved="$(stty -g 2>/dev/null || true)"
	stty -icanon -echo min 1 time 0 2>/dev/null || true
	printf '\e[?2004h'
fi

printf '❯ '
while :; do
	if [ "$havep" = 1 ]; then
		c="$nx"
		havep=0
	else
		IFS= read -r -s -d '' -n 1 c || break
	fi
	if [ "$c" = $'\e' ]; then
		seq=""
		while IFS= read -r -s -d '' -n 1 -t 0.05 c; do
			seq+="$c"
			case "$c" in [A-Za-z~]) break ;; esac
		done
		case "$seq" in
			'[200~') paste=1 ;;
			'[201~') paste=0 closed=1 ;;
		esac
	elif [ "$paste" = 1 ]; then
		[ "$c" = $'\r' ] && c=$'\n'
		line+="$c"
		printf '%s' "$c"
	elif [ "$c" = $'\n' ] || [ "$c" = $'\r' ]; then
		if [ "$closed" = 0 ] && IFS= read -r -s -d '' -n 1 -t 0.25 nx; then
			line+=$'\n'
			printf '\n'
			havep=1
		else
			printf '\n'
			submitted=1
			break
		fi
	elif [ "$c" = $'\x04' ]; then
		break
	elif [ "$c" = $'\x7f' ] || [ "$c" = $'\b' ]; then
		if [ -n "$line" ] && [ "${line: -1}" != $'\n' ]; then
			line="${line%?}"
			printf '\b \b'
		fi
	else
		line+="$c"
		printf '%s' "$c"
	fi
done

if [ -n "$tty_saved" ]; then
	printf '\e[?2004l'
	stty "$tty_saved" 2>/dev/null || true
fi

# Ctrl-D or a closed pane: leave without relaunching, exactly like quitting pi.
[ "$submitted" = 1 ] || exit 0

rm -f "$checkpoint" "$checkpoint.wake"

wake_args=()
if [ -n "${PI_WAKE_SESSION_FILE:-}" ] && [ -f "${PI_WAKE_SESSION_FILE}" ]; then
	wake_args+=(--session "$PI_WAKE_SESSION_FILE")
else
	wake_args+=(--continue)
fi
if [ -n "${PI_WAKE_MODEL:-}" ]; then
	wake_args+=(--model "${PI_WAKE_MODEL}${PI_WAKE_THINKING:+:$PI_WAKE_THINKING}")
fi

if [ -n "$line" ]; then
	case "$line" in
		/* | -*)
			draft="$checkpoint.draft"
			(umask 077 && printf '%s' "$line" >"$draft")
			export PI_SEAT_SLEEP_DRAFT_FILE="$draft"
			;;
		*)
			wake_args+=("$line")
			;;
	esac
fi

exec -a pi "$pi_bin" "${wake_args[@]}"
