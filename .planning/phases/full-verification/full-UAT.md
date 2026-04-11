---
status: complete
phase: full-verification
source: 01-01-SUMMARY.md, 01-02-SUMMARY.md, 02-01-SUMMARY.md, 02-02-SUMMARY.md, 03-01-SUMMARY.md, 04-01-SUMMARY.md, 04-02-SUMMARY.md, 05-01-SUMMARY.md, 05-02-SUMMARY.md
started: 2026-04-09T00:00:00Z
updated: 2026-04-11T14:30:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running server. Run `npm run dev`. Server boots without errors, database connects ("Database connected" log), sessions resume ("Sessions restored" log), WebSocket server set up, and "Server started" log appears on port 3000.
result: pass

### 2. Database Schema Initialization
expected: Run `npm run db:init` in a separate terminal. It exits with 0 and prints "Schema initialized successfully." All 5 tables (reps, wa_auth_keys, wa_auth_creds, messages, close_phone_cache) exist.
result: pass

### 3. Dashboard Page Load
expected: Open http://localhost:3000 in browser. A dark-themed login screen appears with a password input field. Background is dark (#1a1a2e), no errors in browser console.
result: pass

### 4. Dashboard Login
expected: Enter the DASHBOARD_PASSWORD value into the password field and submit. Login screen disappears, replaced by the main dashboard showing a rep list area, an "Add Rep" button, and a send message section.
result: pass

### 5. Add a Sales Rep
expected: Click "Add Rep", fill in a name (e.g., "Test Rep"), optionally a Close User ID and phone, and submit. A new rep card appears in the list with status "needs_qr" (yellow badge). No page refresh needed.
result: pass

### 6. Connect Rep — QR Code Modal
expected: Click "Connect" on a rep card. A QR code modal opens immediately showing "Requesting QR code..." text, then a QR code image appears within a few seconds. A 20-second countdown timer is visible.
result: pass

### 7. QR Code Scan — WhatsApp Connection
expected: Scan the QR code with WhatsApp (Linked Devices). The modal auto-closes, a toast notification shows connection success, and the rep's status badge changes to "connected" (green) in real-time without page refresh.
result: pass

### 8. Inbound WhatsApp Message — DB Storage
expected: Send a WhatsApp message TO the connected rep's number from any phone. Check the `messages` table in PostgreSQL — a new row appears with the correct sender phone, message body, rep_id, and direction "inbound". The message is stored regardless of whether the sender matches a Close lead.
result: pass

### 9. Inbound Message — Close CRM Activity Sync
expected: Send a WhatsApp message from a phone number that belongs to a Close lead's contact. Check Close CRM — a new WhatsApp Message activity appears on that lead with the message content, direction "incoming", and the correct external_whatsapp_message_id.
result: pass

### 10. Send Message from Dashboard
expected: In the dashboard's Send Message section, select a connected rep from the dropdown, enter a valid phone number, type a message, and click Send. The message is delivered to the recipient's WhatsApp. No errors shown.
result: pass

### 11. Outbound via Close Webhook
expected: In Close CRM, create a new WhatsApp Message activity on a lead (outbound direction). The message is sent via the connected rep's WhatsApp to the lead's phone number. The activity in Close is updated with the real WhatsApp message ID (external_whatsapp_message_id patched back).
result: pass

### 12. Webhook Loop Guard
expected: After an outbound message is sent via the webhook (test 11), the activity created/updated in Close already has external_whatsapp_message_id set. If Close fires another webhook for this activity, it should be silently dropped (no duplicate WhatsApp message sent). Check server logs — you should see the loop guard filtering it out.
result: pass

### 13. Disconnect a Rep
expected: Click "Disconnect" on a connected rep's card. The status badge changes to "disconnected" (red) in real-time. The WhatsApp session is gracefully closed but auth state is preserved (rep can reconnect without re-scanning QR).
result: pass

### 14. Remove a Rep
expected: Click "Remove" on a rep card. The rep card disappears from the list. The rep's auth state is cleared from the database (wa_auth_keys, wa_auth_creds rows deleted). The rep no longer appears on page refresh.
result: pass

### 15. WebSocket Live Status Updates
expected: Open the dashboard in two browser tabs. Perform an action (connect/disconnect) in one tab. The status change appears in both tabs simultaneously without refreshing either tab.
result: issue
reported: "if I disconnect and refresh it gets reconnected always"
severity: major

### 16. Bearer Auth Protection
expected: Open a new browser tab/curl and try to access http://localhost:3000/api/reps without a Bearer token (or with a wrong token). You receive a 401 Unauthorized response. The dashboard data is NOT accessible without proper authentication.
result: pass

### 17. Outbound WhatsApp Message — DB Storage
expected: Send a WhatsApp message FROM the connected rep's phone to any contact. Check the `messages` table in PostgreSQL — a new row appears with direction "outgoing", the correct rep_id, recipient phone, and message body. The message is stored regardless of whether the recipient matches a Close lead.
result: pass

### 18. Outbound WhatsApp Message — Close CRM Activity Sync
expected: Send a WhatsApp message FROM the rep's phone to a number that belongs to a Close lead's contact. Check Close CRM — a new WhatsApp Message activity appears on that lead with direction "outbound", the message content, and the correct external_whatsapp_message_id.
result: skipped
reason: Covered by tests 9 and 11

### 19. Outbound Dedup — Close Webhook vs WhatsApp Event
expected: Create an outbound WhatsApp Message activity in Close CRM (triggers webhook → message sent via Baileys). When Baileys fires the fromMe event for that same message, the DB insert should be skipped (ON CONFLICT DO NOTHING, rowCount=0) and NO duplicate Close activity should be created. Verify: only one row in `messages` table for that message ID, only one activity in Close.
result: skipped
reason: Covered by test 12 (loop guard) and DB ON CONFLICT constraint

### 20. Full Conversation Visible in Close
expected: Have a back-and-forth conversation between the rep and a lead-matched contact (at least 2 inbound + 2 outbound messages). Check the lead in Close CRM — all messages appear in chronological order with correct directions (inbound/outbound), forming a complete conversation thread visible to any Close user.
result: pass

## Summary

total: 20
passed: 16
issues: 1
pending: 0
skipped: 2
blocked: 0

## Gaps

- truth: "Disconnected rep stays disconnected after page refresh"
  status: failed
  reason: "User reported: if I disconnect and refresh it gets reconnected always"
  severity: major
  test: 15
  root_cause: "Server startup restores all sessions with saved auth state regardless of rep status"
  artifacts: []
  missing: []
