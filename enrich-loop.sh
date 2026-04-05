#!/usr/bin/env bash

WORKERS="${1:-5}"
BATCH_SIZE=100
MAX_TURNS=30


make_enrich_prompt() {
    local ids_json="$1"
    cat <<PROMPT
You are an email metadata extraction engine for a personal email knowledge graph. The user is Henry Williams, based in Brooklyn, NY.

Call gmail_get_unenriched with max_results=500 and after_year=2017. From the returned emails, only process the ones whose id appears in this list: ${ids_json}

For each of those emails call gmail_write_enrichment with these fields:

- intent_summary: One sentence describing what this email is about in the context of someone's life. Be specific: 'Booking family flight to London' not 'Travel email'.
- life_project: Short descriptive name for the broader project/initiative (e.g. 'Family Cruise July 2025', 'Tristan School PS 183', 'London Trip March 2026', 'Passport Applications'). Use CONSISTENT names -- don't create variants like 'UK Trip' and 'London Trip'. Set to null for purely transactional/promotional emails.
- entities: Array of {name, type, role} where:
    - type is one of: person, place, organization, flight, document, event, institution
    - role is one of: sender, recipient, mentioned, location, destination, provider, subject
    - For flight bookings: extract airline, flight number as separate entities, plus origin/destination places, and all passenger names
    - For appointments: extract provider org, patient/client person, location
    - For co-parenting emails: always extract children mentioned, dates discussed, locations
- topics: Array of tags (up to 5) chosen ONLY from: travel, coparenting, medical, legal, career, finance, technology, family, school, home, civic, insurance, food, shopping, media, passport, immigration
- key_dates: Array of {date: 'YYYY-MM-DD', description} for important dates mentioned
- sentiment: one of: positive, negative, neutral, urgent, confrontational
- email_type: one of: personal, professional, transactional, promotional, notification, legal

Rules:
- Promotional/marketing emails: set life_project to null, email_type to 'promotional'
- Call gmail_write_enrichment once per email, do not skip any in your assigned list
- After all emails are written, report: 'Processed N emails'
PROMPT
}

# ── Indexing loop (runs in background) ──────────────────────────────────────
indexing_loop() {
    echo "[index] Starting indexing loop"

    # Generate months from Dec 2024 back to Apr 2004 (Gmail launch)
    while IFS= read -r range; do
        after=$(echo "$range" | cut -d' ' -f1)
        before=$(echo "$range" | cut -d' ' -f2)
        echo "[index] Indexing $after → $before"
        result=$(claude -p \
            "Call gmail_index_emails with query 'after:${after} before:${before}', index_all=true, skip_promotional=false. Report how many emails were indexed." \
            --allowedTools "mcp__claude_ai_Gmail_MCP__gmail_index_emails" \
            --permission-mode bypassPermissions \
            --model haiku \
            --max-turns 5 \
            2>&1)
        echo "[index] $after → $before: $result"
        sleep 3
    done < <(python3 - <<'PYEOF'
from datetime import date
year, month = 2024, 12
while (year, month) >= (2004, 4):
    after = date(year, month, 1)
    ny, nm = (year + 1, 1) if month == 12 else (year, month + 1)
    before = date(ny, nm, 1)
    print(f'{after.strftime("%Y/%m/%d")} {before.strftime("%Y/%m/%d")}')
    year, month = (year - 1, 12) if month == 1 else (year, month - 1)
PYEOF
)
    echo "[index] Indexing complete"
}

# ── Enrichment loop (runs in background) ────────────────────────────────────
enrichment_loop() {
    echo "[enrich] Starting enrichment loop"
    local round=0

    while true; do
        round=$((round + 1))
        echo "[enrich] Round $round [$(date '+%H:%M:%S')] fetching IDs"

        raw=$(claude -p \
            "Call gmail_get_unenriched with max_results=500 and after_year=2017. Return ONLY a JSON array of the email ids, nothing else. Example: [\"id1\",\"id2\"]" \
            --allowedTools "mcp__claude_ai_Gmail_MCP__gmail_get_unenriched" \
            --permission-mode bypassPermissions \
            --model haiku \
            --max-turns 5 \
            2>&1)

        ids_json=$(echo "$raw" | grep -o '\[.*\]' | head -1)

        if [ -z "$ids_json" ] || [ "$ids_json" = "[]" ]; then
            echo "[enrich] No unenriched emails right now, sleeping 30s..."
            sleep 30
            continue
        fi

        chunks=$(python3 2>/dev/null -c "
import json, sys
ids = json.loads(sys.argv[1])
n = $WORKERS
size = max(1, len(ids) // n)
for i in range(n):
    chunk = ids[i*size:(i+1)*size]
    if chunk:
        print(json.dumps(chunk))
" "$ids_json")

        worker_id=0
        while IFS= read -r chunk; do
            worker_id=$((worker_id + 1))
            (
                prompt=$(make_enrich_prompt "$chunk")
                result=$(claude -p "$prompt" \
                    --allowedTools "mcp__claude_ai_Gmail_MCP__gmail_get_unenriched,mcp__claude_ai_Gmail_MCP__gmail_write_enrichment" \
                    --permission-mode bypassPermissions \
                    --model haiku \
                    --max-turns "$MAX_TURNS" \
                    2>&1)
                echo "[enrich-$worker_id] $result"
            ) &
        done <<< "$chunks"

        echo "[enrich] Round $round: waiting for $worker_id workers"
        wait
        echo "[enrich] Round $round done [$(date '+%H:%M:%S')]"
    done
}

# ── Main ─────────────────────────────────────────────────────────────────────
echo "=== Gmail Index + Enrichment ==="
echo "Enrich workers: $WORKERS | Emails per round: $((WORKERS * BATCH_SIZE))"
echo "Started: $(date)"
echo ""

indexing_loop &
INDEX_PID=$!

enrichment_loop &
ENRICH_PID=$!

# Wait for indexing to finish; enrichment runs until interrupted
wait $INDEX_PID
echo ""
echo "=== Indexing complete. Enrichment still running (Ctrl+C to stop) ==="
wait $ENRICH_PID
