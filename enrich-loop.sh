#!/usr/bin/env bash

WORKERS=5
MAX_TURNS=20

ENRICH_PROMPT='You are an email metadata extraction engine for a personal email knowledge graph. The user is Henry Williams, based in Brooklyn, NY.

Call gmail_get_unenriched with max_results=500 and after_year=2017. From the returned emails, only process the ones whose id appears in this list: IDS_PLACEHOLDER

For each of those emails call gmail_write_enrichment with these fields:
- intent_summary: One sentence what this email is about. Be specific.
- life_project: Descriptive project name (e.g. "Family Cruise July 2025", "Tristan School PS 183") or null for transactional/promotional.
- entities: [{name, type, role}] where type: person/place/organization/flight/document/event/institution, role: sender/recipient/mentioned/location/destination/provider/subject
- topics: up to 5 tags from: travel, coparenting, medical, legal, career, finance, technology, family, school, home, civic, insurance, food, shopping, media, passport, immigration
- key_dates: [{date: "YYYY-MM-DD", description}]
- sentiment: positive/negative/neutral/urgent/confrontational
- email_type: personal/professional/transactional/promotional/notification/legal

Call gmail_write_enrichment once per email. After done report: "Processed N emails"'

echo "=== Gmail Index + Enrichment ==="
echo "Started: $(date)"
echo ""

# ── Indexing loop ─────────────────────────────────────────────────────────────
indexing_loop() {
    echo "[index] Starting indexing loop"
    while IFS= read -r range; do
        after=$(echo "$range" | cut -d' ' -f1)
        before=$(echo "$range" | cut -d' ' -f2)
        echo "[index] $after → $before"
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

# ── Enrichment loop ───────────────────────────────────────────────────────────
enrichment_loop() {
    echo "[enrich] Starting enrichment loop"
    local round=0

    while true; do
        round=$((round + 1))
        echo "[enrich] Round $round [$(date '+%H:%M:%S')]"

        # Fetch 50 IDs
        raw=$(claude -p \
            "Call gmail_get_unenriched with max_results=50 and after_year=2017. Return a single-line JSON array of just the ids. No markdown." \
            --allowedTools "mcp__claude_ai_Gmail_MCP__gmail_get_unenriched" \
            --permission-mode bypassPermissions \
            --model haiku \
            --max-turns 3 \
            2>&1)

        ids_json=$(echo "$raw" | python3 2>/dev/null -c "
import sys, re, json
m = re.search(r'\[.*?\]', sys.stdin.read(), re.DOTALL)
if m:
    try: print(json.dumps(json.loads(m.group())))
    except: pass
")

        if [ -z "$ids_json" ] || [ "$ids_json" = "[]" ]; then
            echo "[enrich] No emails, sleeping 30s..."
            sleep 30
            continue
        fi

        # Split 50 IDs into 5 chunks of 10
        readarray -t chunks < <(python3 2>/dev/null -c "
import json, sys
ids = json.loads(sys.argv[1])
size = max(1, len(ids) // $WORKERS)
for i in range($WORKERS):
    chunk = ids[i*size:(i+1)*size]
    if chunk: print(json.dumps(chunk))
" "$ids_json")

        # Launch one worker per chunk
        for i in "${!chunks[@]}"; do
            chunk="${chunks[$i]}"
            prompt="${ENRICH_PROMPT/IDS_PLACEHOLDER/$chunk}"
            (
                result=$(claude -p "$prompt" \
                    --allowedTools "mcp__claude_ai_Gmail_MCP__gmail_get_unenriched,mcp__claude_ai_Gmail_MCP__gmail_write_enrichment" \
                    --permission-mode bypassPermissions \
                    --model haiku \
                    --max-turns "$MAX_TURNS" \
                    2>&1)
                echo "[enrich-$((i+1))] $result"
            ) &
        done

        wait
        echo "[enrich] Round $round done"
    done
}

indexing_loop &
enrichment_loop &
wait
