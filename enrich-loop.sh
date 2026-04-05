#!/usr/bin/env bash

WORKERS=5
MAX_TURNS=20

ENRICH_PROMPT='You are an email metadata extraction engine for a personal email knowledge graph. The user is Henry Williams, based in Brooklyn, NY.

Call gmail_get_unenriched with max_results=10 and after_year=2017.
If no emails are returned respond with exactly: DONE
Otherwise for each email call gmail_write_enrichment with:
- intent_summary: one sentence, specific (e.g. "Booking family flight to London" not "Travel email")
- life_project: descriptive project name (e.g. "Family Cruise July 2025", "Tristan School PS 183") or null for transactional/promotional
- entities: [{name, type, role}] — type: person/place/organization/flight/document/event/institution, role: sender/recipient/mentioned/location/destination/provider/subject
- topics: up to 5 from: travel, coparenting, medical, legal, career, finance, technology, family, school, home, civic, insurance, food, shopping, media, passport, immigration
- key_dates: [{date: "YYYY-MM-DD", description}]
- sentiment: positive/negative/neutral/urgent/confrontational
- email_type: personal/professional/transactional/promotional/notification/legal
Call gmail_write_enrichment once per email. Report: "Processed N emails"'

echo "=== Gmail Index + Enrichment ==="
echo "Started: $(date)"
echo ""

# ── Indexing loop ─────────────────────────────────────────────────────────────
indexing_loop() {
    echo "[index] Starting"
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
        echo "[index] done: $result"
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
    echo "[index] Complete"
}

# ── Enrichment worker (loops independently) ───────────────────────────────────
enrich_worker() {
    local id=$1
    sleep $((id * 5))   # stagger starts to reduce overlap
    local batch=0
    while true; do
        batch=$((batch + 1))
        result=$(claude -p "$ENRICH_PROMPT" \
            --allowedTools "mcp__claude_ai_Gmail_MCP__gmail_get_unenriched,mcp__claude_ai_Gmail_MCP__gmail_write_enrichment" \
            --permission-mode bypassPermissions \
            --model haiku \
            --max-turns "$MAX_TURNS" \
            2>&1)
        echo "[enrich-$id] batch $batch: $result"
        if echo "$result" | grep -qiE "(^|[^a-z])DONE([^a-z]|$)"; then
            sleep 30
        fi
    done
}

indexing_loop &

for i in $(seq 1 $WORKERS); do
    enrich_worker "$i" &
done

wait
