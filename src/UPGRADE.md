# PCO MCP v2.0 — Upgrade Guide

This bundle takes your `planning-center-mcp` server from 7 tools (v1) to **54 tools** (v2.0) covering every PCO product: People, Services, Groups, Check-Ins, Giving, and Calendar — plus a curated set of safe write operations.

## What's in this bundle

```
src/
├── server.ts                         # REPLACE — registers all new tool modules
├── services/
│   └── pco-client.ts                 # REPLACE — adds pcoPost, pcoPatch, pcoDelete
└── tools/
    ├── lists.ts                      # NEW — solves the original debugging question
    ├── households.ts                 # NEW
    ├── workflows.ts                  # NEW
    ├── forms.ts                      # NEW
    ├── services-extra.ts             # NEW — songs, teams, schedules, blockouts
    ├── checkins-extra.ts             # NEW — events, locations, attendance counts
    ├── giving-extra.ts               # NEW — funds, batches, pledges, person donations
    ├── groups-extra.ts               # NEW — group detail, members, events, attendances
    ├── calendar.ts                   # NEW — events, instances, resources, bookings
    └── writes.ts                     # NEW — update profiles, add notes, manage workflows/lists
```

Existing files (`people.ts`, `services.ts`, `groups.ts`, `checkins.ts`, `giving.ts`) are **unchanged**. Don't touch them.

## How to ship it

1. **Drop in the files** — copy the `src/` directory in this bundle over your repo's `src/` directory. Only `server.ts` and `services/pco-client.ts` are replacements; everything else is new.

2. **Verify the build locally** (optional but recommended):
   ```bash
   cd planning-center-mcp
   npm install
   npm run build
   ```
   Should compile cleanly. I've already verified this.

3. **Commit and push**:
   ```bash
   git checkout -b v2-full-coverage
   git add src/
   git commit -m "v2.0: full PCO coverage — 54 tools across People, Services, Groups, Check-Ins, Giving, Calendar"
   git push origin v2-full-coverage
   ```

4. **Vercel auto-deploys the preview**. Check it builds, then merge to main.

5. **Reconnect the MCP connector in Claude** (Settings → Connectors → PCO MCP → disconnect + reconnect) to pick up the new tool list.

## Tool inventory (54 total)

### People (15)
Existing: `pc_list_people`, `pc_get_person`
New: `pc_list_lists`, `pc_get_list`, `pc_list_people_on_list`, `pc_list_households`, `pc_get_household`, `pc_list_workflows`, `pc_get_workflow`, `pc_list_workflow_cards`, `pc_list_forms`, `pc_list_form_submissions`, `pc_list_field_definitions`

### Services (8)
Existing: `pc_list_services`, `pc_get_service`
New: `pc_list_service_types`, `pc_list_songs`, `pc_get_song`, `pc_list_teams`, `pc_list_team_members`, `pc_list_person_schedules`, `pc_list_person_blockouts`

### Check-Ins (4)
Existing: `pc_list_checkins`
New: `pc_list_checkin_events`, `pc_get_checkin_event`, `pc_list_event_locations`

### Giving (6)
Existing: `pc_list_donations`
New: `pc_list_funds`, `pc_list_batches`, `pc_list_pledge_campaigns`, `pc_list_pledges`, `pc_get_donation`, `pc_list_person_donations`

### Groups (7)
Existing: `pc_list_groups`
New: `pc_get_group`, `pc_list_group_members`, `pc_list_group_events`, `pc_list_group_event_attendances`, `pc_list_group_types`, `pc_list_group_tags`

### Calendar (7) — entirely new product
`pc_list_calendar_events`, `pc_get_calendar_event`, `pc_list_calendar_event_instances`, `pc_list_calendar_resources`, `pc_list_resource_bookings`, `pc_list_calendar_conflicts`, `pc_list_calendar_tags`

### Writes (7)
`pc_update_person`, `pc_add_person_note`, `pc_add_person_to_workflow`, `pc_complete_workflow_card`, `pc_add_person_to_list`, `pc_remove_person_from_list`, `pc_mark_group_attendance`

## What's intentionally NOT included

A few things I deliberately left out, all for safety reasons:

- **Delete person, delete group, delete list** — these are irreversible and I don't want a chat session to wipe data accidentally. Do destructive ops in the PCO web UI.
- **Bulk donation creation** — financial data should be handled with extra care. Batches should be created in the Giving UI.
- **Email/phone/address mutation** — these are separate JSON:API resources that need their own write tools; happy to add if you want them.
- **Workflow step manipulation** — moving cards between specific steps is more complex than just "complete". The `pc_complete_workflow_card` tool advances/completes via PCO's `/go` action which is the safe default.

## Trying it out — answer your original debugging question

Once deployed, ask me:

> "Use pc_get_list on list 4875343 and tell me what the subset value is."

That'll directly show whether the list is configured to scope to active/inactive/all profiles, and we'll resolve the inactive-profile mystery.

## Known caveats

- All tools follow the existing read-only pattern except those in `writes.ts`. Write tools have `readOnlyHint: false` so MCP clients can warn appropriately.
- `pc_remove_person_from_list` has `destructiveHint: true` since it removes data.
- The PCO API rate limit is 100 requests/20 seconds. Tools that fan out (like `pc_list_services` which iterates service types) may hit this on large accounts — the existing `handlePcoError` helper surfaces 429s clearly.
- Some `where[...]` filters in PCO are case-sensitive. The tools use them as documented but if you find an unexpected empty result, try the search without the filter and verify the value spelling.

## What's next

When you find tools that are missing or need tweaking after using them in real life, just point me at what's not working and we can iterate. Real usage will surface what's actually missing far faster than guessing up front.
